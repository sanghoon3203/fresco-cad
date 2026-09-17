#include "canvas.h"

#include <QDir>
#include <QEventLoop>
#include <QGuiApplication>
#include <QHoverEvent>
#include <QImage>
#include <QMouseEvent>
#include <QQuickWindow>
#include <QSGNode>
#include <QSGRendererInterface>
#include <QTemporaryDir>
#include <QTextStream>
#include <QTimer>
#include <QTest>

class VisualCanvas : public CadCanvas {
public:
    using CadCanvas::CadCanvas;
    void rebuild() { rebuild_ = true; update(); }
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
protected:
    QSGNode *updatePaintNode(QSGNode *old, UpdatePaintNodeData *data) override {
        // Delete on the actual render thread; Qt then owns the replacement root.
        if (rebuild_) { delete old; old = nullptr; rebuild_ = false; }
        return CadCanvas::updatePaintNode(old, data);
    }
private:
    bool rebuild_ = false;
};

QImage capture(QQuickWindow &window)
{
    QEventLoop loop;
    QTimer deadline;
    deadline.setSingleShot(true);
    bool rendered = false;
    QObject::connect(&window, &QQuickWindow::frameSwapped, &loop,
                     [&] { rendered = true; loop.quit(); }, Qt::QueuedConnection);
    QObject::connect(&deadline, &QTimer::timeout, &loop, &QEventLoop::quit);
    deadline.start(5000);
    window.update();
    loop.exec();
    return rendered ? window.grabWindow().convertToFormat(QImage::Format_ARGB32) : QImage();
}

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    QTemporaryDir temporary;
    if (!temporary.isValid()) return 1;
    const QDir output(argc > 1 ? QString::fromLocal8Bit(argv[1]) : temporary.path());
    if (!QDir().mkpath(output.absolutePath())) return 1;
    QQuickWindow window;
    window.setTitle("Fresco CAD — Metal retained-text check");
    window.setColor(Qt::white);
    window.resize(1000, 700);
    VisualCanvas canvas(window.contentItem());
    canvas.setSize({1000, 700});
    canvas.gridSnap = canvas.objectSnap = false;
    canvas.palette = {{"grid", "#d5dedc"}, {"ink", "#172f55"}, {"secondaryInk", "#26845d"},
                      {"annotationInk", "#26845d"}, {"focus", "#cc5500"}};
    QVector<cad::Entity> entities;
    const QStringList labels = {QStringLiteral("執務室　寸法 1000 mm"),
                                QStringLiteral("회의실　치수 1000 mm"),
                                QStringLiteral("WORKSPACE　1000 mm")};
    for (int i = 0; i < labels.size(); ++i) {
        cad::Entity entity;
        entity.id = QString::number(i);
        entity.kind = cad::Kind::Text;
        entity.a = {1200, 4400.0-i*1000};
        entity.text = labels[i]; entity.textHeight = 360; entity.layer = 2;
        entities << entity;
    }
    cad::Entity line;
    line.id = "diagonal"; line.a = {0, 0}; line.b = {8000, 6000}; line.layer = 1;
    entities << line;
    cad::Entity arc;
    arc.id = "analytic-arc"; arc.kind = cad::Kind::Arc; arc.a = {6200, 3500};
    arc.radius = 800; arc.startDegrees = 350; arc.sweepDegrees = 100; arc.layer = 1;
    entities << arc;
    cad::Document document;
    const QString source = temporary.filePath("visual.fresco");
    if (!document.apply(entities, {}, 0) || !document.save(source) ||
        !canvas.load(QUrl::fromLocalFile(source))) return 1;
    window.show();
    const QImage initial = capture(window);
    if (initial.isNull() || window.rendererInterface()->graphicsApi() != QSGRendererInterface::Metal) {
        QTextStream(stderr) << "FAIL: this check requires a visible window with the Metal renderer.\n";
        return 1;
    }
    // Count text-colored pixels in each language's initial baseline rectangle.
    const double dpr = initial.width()/canvas.width();
    for (int i = 0; i < labels.size(); ++i) {
        const QPointF origin = canvas.view().screen(entities[i].a);
        const double height = entities[i].textHeight*canvas.view().scale;
        const QRect region = QRectF((origin-QPointF(0, height*1.5))*dpr,
                                    QSizeF(650, height*2)*dpr).toAlignedRect().intersected(initial.rect());
        int ink = 0;
        for (int y = region.top(); y <= region.bottom(); ++y)
            for (int x = region.left(); x <= region.right(); ++x) {
                const QColor pixel = initial.pixelColor(x, y);
                ink += pixel.red()<80 && pixel.green()<100 && pixel.blue()>pixel.red()*1.2;
            }
        if (ink < 100) { QTextStream(stderr) << "FAIL: no visible text for language " << i << '\n'; return 1; }
    }
    int comparisons = 0;
    auto compare = [&](const QString &name) {
        const QImage retained = capture(window);
        canvas.rebuild();
        const QImage rebuilt = capture(window);
        const bool equal = !retained.isNull() && retained == rebuilt;
        if (!retained.save(output.filePath(name+".png"))) return false;
        if (!equal) {
            rebuilt.save(output.filePath(name+"-rebuilt.png"));
            QTextStream(stderr) << "FAIL retained/rebuilt pixels: " << name << '\n';
            return false;
        }
        ++comparisons;
        return true;
    };
    if (!compare("01-initial")) return 1;
    canvas.hover({900, 650});
    if (!compare("02-hover")) return 1;
    canvas.pan({-1200, 0});
    if (!compare("03-text-outside")) return 1;
    canvas.pan({1200, 0});
    if (!compare("04-text-returned")) return 1;
    canvas.zoomStep(0.04);
    if (!compare("05-below-two-pixels")) return 1;
    canvas.zoomStep(1.5);
    if (!compare("06-above-two-pixels")) return 1;
    canvas.zoomStep(1/0.06);
    if (!compare("07-zoom-restored")) return 1;
    canvas.selectNext();
    if (!compare("08-japanese-selected")) return 1;
    canvas.selectNext();
    if (!compare("09-korean-selected")) return 1;
    canvas.setLayerVisible(2, false);
    if (!compare("10-text-hidden")) return 1;
    canvas.setLayerVisible(2, true);
    if (!compare("11-text-visible")) return 1;
    canvas.palette["ink"] = "#743a93";
    canvas.update();
    if (!compare("12-text-recolored")) return 1;
    // A burst keeps native updates alive briefly; it must not become an idle render loop.
    canvas.setAcceptHoverEvents(false);
    QTest::qWait(180);
    int pulses = 0;
    const auto pulseConnection = QObject::connect(&window, &QQuickWindow::afterAnimating,
                                                  &window, [&] { ++pulses; });
    canvas.hover({820, 610});
    QTest::qWait(120);
    if (pulses < 2) { QTextStream(stderr) << "FAIL input burst did not sustain updates\n"; return 1; }
    const int settled = pulses;
    QTest::qWait(120);
    if (pulses != settled) { QTextStream(stderr) << "FAIL input burst kept rendering when idle\n"; return 1; }
    canvas.hover({830, 610});
    QTest::qWait(120);
    if (pulses <= settled) { QTextStream(stderr) << "FAIL input burst did not restart\n"; return 1; }
    canvas.hover({840, 610});
    canvas.setParentItem(nullptr);
    QTest::qWait(180);
    const int detached = pulses;
    QTest::qWait(120);
    if (pulses != detached) { QTextStream(stderr) << "FAIL detached canvas kept updating its old window\n"; return 1; }
    QObject::disconnect(pulseConnection);
    QTextStream(stdout) << "PASS 4 input burst checks (active, idle, restart, detach)\n";
    QTextStream(stdout) << "PASS " << comparisons << " Metal retained/rebuilt pixel comparisons; "
                        << "Japanese/Korean/English text present; physical size " << initial.width()
                        << 'x' << initial.height() << "; DPR " << dpr << '\n';
    return 0;
}
