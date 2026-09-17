#include "canvas.h"

#include <QGuiApplication>
#include <QHoverEvent>
#include <QMouseEvent>
#include <QSGFlatColorMaterial>
#include <QSGGeometryNode>
#include <QTemporaryDir>
#include <QTextStream>
#include <algorithm>
#include <cmath>
#include <memory>

namespace {
int checks = 0;
bool check(bool result, const char *expression)
{
    ++checks;
    if (!result) QTextStream(stderr) << "FAIL " << checks << ": " << expression << '\n';
    return result;
}
#define CHECK(expression) do { if (!check(bool(expression), #expression)) return 1; } while (false)

// Line-only scene-graph synchronization check: no window, graphics resources,
// text nodes, or renderer is started. All node access stays on this one thread.
class CanvasProbe : public CadCanvas {
public:
    QSGNode *synchronize(QSGNode *old) { return updatePaintNode(old, nullptr); }
    void hover(QPointF position) {
        QHoverEvent event(QEvent::HoverMove, position, position, position);
        hoverMoveEvent(&event);
    }
    void pan(QPointF delta) {
        const QPointF start(500, 350), end = start + delta;
        QMouseEvent press(QEvent::MouseButtonPress, start, start, Qt::MiddleButton,
                          Qt::MiddleButton, Qt::NoModifier);
        mousePressEvent(&press);
        QMouseEvent move(QEvent::MouseMove, end, end, Qt::NoButton,
                         Qt::MiddleButton, Qt::NoModifier);
        mouseMoveEvent(&move);
        QMouseEvent release(QEvent::MouseButtonRelease, end, end, Qt::MiddleButton,
                            Qt::NoButton, Qt::NoModifier);
        mouseReleaseEvent(&release);
    }
};

struct Geometry {
    QVector<float> coordinates;
    QVector<QColor> colors;
    bool operator==(const Geometry &) const = default;
};
Geometry geometry(QSGNode *root)
{
    Geometry result;
    auto visit = [&](auto &&self, QSGNode *node) -> void {
        if (node->type() == QSGNode::GeometryNodeType) {
            const auto *item = static_cast<QSGGeometryNode *>(node);
            const auto *data = item->geometry();
            const auto *vertices = data->vertexDataAsPoint2D();
            for (int i = 0; i < data->vertexCount(); ++i)
                result.coordinates << vertices[i].x << vertices[i].y;
            result.colors << static_cast<QSGFlatColorMaterial *>(item->material())->color();
        }
        for (auto *child = node->firstChild(); child; child = child->nextSibling()) self(self, child);
    };
    visit(visit, root);
    return result;
}

// A harmless child detects destruction even if malloc reuses the same address.
struct LifetimeProbe : QSGNode {
    explicit LifetimeProbe(bool &destroyed) : destroyed(destroyed) {}
    ~LifetimeProbe() override { destroyed = true; }
    bool &destroyed;
};
bool near(double a, double b, double tolerance = 0.0001) { return std::abs(a-b) <= tolerance; }
double horizontalStrokeWidth(const Geometry &shape)
{
    double low = 1e30, high = -1e30;
    for (qsizetype i = 1; i < shape.coordinates.size(); i += 2) {
        low = std::min(low, double(shape.coordinates[i]));
        high = std::max(high, double(shape.coordinates[i]));
    }
    return high-low;
}
} // namespace

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    QTemporaryDir temporary;
    CHECK(temporary.isValid());
    CanvasProbe canvas;
    canvas.setSize({1000, 700});
    canvas.gridSnap = canvas.objectSnap = false;
    canvas.palette = {{"grid", "#d0d0d0"}, {"ink", "#123456"}, {"focus", "#cc5500"}};
    CHECK(canvas.line(4800, 3500, 5200, 3500));
    bool gridDestroyed = false, drawingDestroyed = false;
    std::unique_ptr<QSGNode> root(canvas.synchronize(nullptr));
    CHECK(root && root->childCount() == 3);
    auto *rootIdentity = root.get();
    auto *grid = root->childAtIndex(0);
    auto *drawing = root->childAtIndex(1);
    auto *overlay = root->childAtIndex(2);
    auto sync = [&] { root.reset(canvas.synchronize(root.release())); };
    auto stableGroups = [&] {
        return root.get() == rootIdentity && root->childAtIndex(0) == grid &&
               root->childAtIndex(1) == drawing && root->childAtIndex(2) == overlay;
    };
    const Geometry firstDrawing = geometry(drawing), firstGrid = geometry(grid);
    CHECK(firstDrawing.coordinates.size() == 12);
    CHECK(near(horizontalStrokeWidth(firstDrawing), 1.8));
    grid->appendChildNode(new LifetimeProbe(gridDestroyed));
    drawing->appendChildNode(new LifetimeProbe(drawingDestroyed));
    const Geometry firstOverlay = geometry(overlay);
    canvas.hover({300, 250});
    sync();
    CHECK(stableGroups() && !gridDestroyed && !drawingDestroyed);
    CHECK(geometry(drawing) == firstDrawing && geometry(grid) == firstGrid);
    CHECK(geometry(overlay) != firstOverlay);
    canvas.cancel();
    sync();
    CHECK(stableGroups() && !gridDestroyed && !drawingDestroyed);

    CHECK(canvas.line(4800, 3300, 5200, 3300));
    sync();
    CHECK(stableGroups() && drawingDestroyed && !gridDestroyed);
    const Geometry twoLines = geometry(drawing);
    CHECK(twoLines.coordinates.size() == 24 && twoLines != firstDrawing);
    canvas.undo(); sync();
    CHECK(stableGroups() && geometry(drawing) == firstDrawing);
    canvas.redo(); sync();
    CHECK(stableGroups() && geometry(drawing) == twoLines);
    const auto revision = canvas.document().revision();
    CHECK(canvas.save(QUrl::fromLocalFile(temporary.filePath("saved.fresco"))));
    sync();
    CHECK(stableGroups() && canvas.document().revision() == revision && geometry(drawing) == twoLines);

    canvas.selectNext(); sync();
    CHECK(stableGroups() && geometry(drawing).colors.contains(QColor("#cc5500")));
    CHECK(geometry(drawing) != twoLines);
    canvas.moveSelected(50, 25); sync();
    CHECK(stableGroups() && geometry(drawing) != twoLines);
    canvas.undo(); sync();
    CHECK(stableGroups() && geometry(drawing) == twoLines);
    canvas.setLayerVisible(0, false); sync();
    CHECK(stableGroups() && geometry(drawing).coordinates.isEmpty());
    canvas.setLayerVisible(0, true); sync();
    CHECK(stableGroups() && geometry(drawing) == twoLines);
    canvas.palette["ink"] = "#abcdef";
    sync();
    CHECK(stableGroups() && geometry(drawing).colors.contains(QColor("#abcdef")));

    cad::Entity farLine;
    farLine.id = "large-coordinate-line";
    farLine.a = {999999900, 999999800};
    farLine.b = {999999910, 999999800};
    cad::Document farDocument;
    CHECK(farDocument.apply({farLine}, {}, 0));
    const QString farPath = temporary.filePath("far.fresco");
    CHECK(farDocument.save(farPath) && canvas.load(QUrl::fromLocalFile(farPath)));
    sync();
    CHECK(stableGroups() && canvas.count() == 1 && geometry(drawing).coordinates.size() == 12);
    const Geometry farBefore = geometry(drawing);
    const auto centerBefore = canvas.view().center;
    canvas.pan({0.001, 0});
    sync();
    const Geometry farAfter = geometry(drawing);
    CHECK(stableGroups() && canvas.view().center.x() != centerBefore.x());
    CHECK(farBefore != farAfter);
    const double expectedShift = -(canvas.view().center.x()-centerBefore.x()) * canvas.view().scale;
    CHECK(near(farAfter.coordinates[0]-farBefore.coordinates[0], expectedShift));
    CHECK(near(horizontalStrokeWidth(farAfter), 1.8));
    canvas.zoomStep(0.5); sync();
    CHECK(stableGroups() && geometry(drawing) != farAfter);
    CHECK(near(horizontalStrokeWidth(geometry(drawing)), 1.8));
    canvas.setSize({1100, 750}); sync();
    CHECK(stableGroups() && near(horizontalStrokeWidth(geometry(drawing)), 1.8));

    // Recreate the entire root, as after scene-graph invalidation.
    const Geometry beforeRelease = geometry(drawing);
    root.reset();
    root.reset(canvas.synchronize(nullptr));
    CHECK(root && root->childCount() == 3 && geometry(root->childAtIndex(1)) == beforeRelease);
    QTextStream(stdout) << "PASS " << checks << " render synchronization checks (line geometry, cache invalidation, precision, stroke width)\n";
    return 0;
}
