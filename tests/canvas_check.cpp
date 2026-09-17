#include "canvas.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <QTest>
#include <QTextStream>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickStyle>
#include <cmath>
#include <limits>

namespace {
int checks = 0;
bool check(bool result, const char *expression)
{
    ++checks;
    if (!result) QTextStream(stderr) << "FAIL " << checks << ": " << expression << '\n';
    return result;
}
#define CHECK(expression) do { if (!check(bool(expression), #expression)) return 1; } while (false)

bool near(double a, double b, double tolerance = 1e-7) { return std::abs(a - b) <= tolerance; }
bool near(QPointF a, QPointF b, double tolerance = 1e-7)
{ return near(a.x(), b.x(), tolerance) && near(a.y(), b.y(), tolerance); }
QByteArray read(const QString &path)
{
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
}
cad::Entity line(QString id, QPointF a, QPointF b, int layer = 0)
{
    cad::Entity result;
    result.id = id; result.a = a; result.b = b; result.layer = layer;
    return result;
}
bool writeDocument(const QString &path, const QVector<cad::Entity> &entities)
{
    cad::Document document;
    return document.apply(entities, {}, 0) && document.save(path);
}

// Inspect only PDFs generated in this check by Qt, not arbitrary PDF inputs.
// qUncompress accepts the Qt length prefix followed by a zlib/Flate stream.
QList<QByteArray> graphicsStreams(const QByteArray &pdf)
{
    QList<QByteArray> result;
    qsizetype at = 0;
    while ((at = pdf.indexOf("stream\n", at)) >= 0) {
        const qsizetype start = at + 7;
        const qsizetype end = pdf.indexOf("\nendstream", start);
        if (end < 0) break;
        const qsizetype dictionaryStart = pdf.lastIndexOf("<<", at);
        if (dictionaryStart < 0 || !pdf.mid(dictionaryStart, at-dictionaryStart).contains("/FlateDecode")) {at=end+10; continue;}
        const QByteArray inflated = qUncompress(QByteArray::fromHex("00100000") + pdf.mid(start, end - start));
        if (inflated.contains(" cm") && inflated.contains(" m")) result.append(inflated);
        at = end + 10;
    }
    return result;
}
} // namespace

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    QQuickStyle::setStyle("Basic");
    QQmlEngine qml;
    qml.rootContext()->setContextProperty("theme",QJsonDocument::fromJson(read(":/qml/theme.json")).object().toVariantMap());
    QQmlComponent fieldComponent(&qml,QUrl("qrc:/qml/Field.qml"));
    std::unique_ptr<QObject> field(fieldComponent.create());
    CHECK(field != nullptr);
    field->setProperty("text","1,000");
    CHECK(field->property("valid").toBool() && field->property("numericValue").toDouble()==1000);
    field->setProperty("text","-1,234.125");
    CHECK(field->property("valid").toBool() && field->property("numericValue").toDouble()==-1234.125);
    field->setProperty("text","");
    CHECK(!field->property("valid").toBool() && std::isnan(field->property("numericValue").toDouble()));
    QTemporaryDir temporary;
    CHECK(temporary.isValid());
    QString evidence = temporary.path();
    const QStringList args = app.arguments();
    const int option = args.indexOf("--evidence-dir");
    if (option >= 0) {
        CHECK(option + 1 < args.size());
        evidence = QDir(args[option + 1]).absolutePath();
        CHECK(QDir().mkpath(evidence));
    }
    const QDir output(evidence);
    const QDir scratch(temporary.path());

    cad::View view;
    view.center = { 999999990.1234567, -888888880.456789 };
    view.scale = 0.1234567;
    const QPointF precise = view.center + QPointF(0.000001, 123.125);
    CHECK(near(view.world(view.screen(precise)), precise, 2e-7));
    const QPointF anchor(193.25, 201.75), anchoredWorld = view.world(anchor);
    view.zoom(anchor, 3.25);
    CHECK(near(view.world(anchor), anchoredWorld, 2e-7));
    view.zoom(anchor, 1e-20);
    CHECK(view.scale == 0.00001);
    CHECK(near(view.world(anchor), anchoredWorld, 2e-7));
    view.zoom(anchor, 1e20);
    CHECK(view.scale == 20);
    CHECK(near(view.world(anchor), anchoredWorld, 2e-7));
    CHECK(near(cad::segmentDistance({ 5, 3 }, { 0, 0 }, { 10, 0 }), 3));
    CHECK(near(cad::segmentDistance({ -3, 4 }, { 0, 0 }, { 10, 0 }), 5));
    CHECK(near(cad::segmentDistance({ 3, 4 }, { 0, 0 }, { 0, 0 }), 5));
    cad::Entity sweep;
    sweep.id = "analytical-arc"; sweep.kind = cad::Kind::Arc; sweep.radius = 100;
    sweep.startDegrees = 350; sweep.sweepDegrees = 20;
    CHECK(near(cad::entityDistance({ 100, 0 }, sweep), 0));
    CHECK(cad::entityDistance({ -100, 0 }, sweep) > 190);
    CHECK(near(cad::entityDistance({ 110, 0 }, sweep), 10));
    sweep.startDegrees = 10; sweep.sweepDegrees = -20;
    CHECK(near(cad::entityDistance({ 100, 0 }, sweep), 0));
    CHECK(cad::entityDistance({ 0, 100 }, sweep) > 120);
    sweep.startDegrees = 360000010;
    CHECK(near(cad::entityDistance({ 100, 0 }, sweep), 0));

    QQuickWindow window;
    window.resize(1000, 700);
    CadCanvas canvas(window.contentItem());
    canvas.setSize({ 1000, 700 });
    window.show();
    CHECK(QTest::qWaitForWindowExposed(&window));
    canvas.forceActiveFocus();
    auto click = [&](QPoint screen) { QTest::mouseClick(&window, Qt::LeftButton, Qt::NoModifier, screen); };
    CHECK(canvas.view().size == QSizeF(1000, 700));
    canvas.objectSnap = false;
    canvas.setTool("line");
    click({ 500, 350 });
    CHECK(canvas.stage() == 1 && canvas.count() == 0);
    click({ 575, 350 });
    CHECK(canvas.count() == 1 && canvas.stage() == 0);
    CHECK(near(canvas.document().entities()[0].a, { 5000, 3500 }));
    CHECK(near(canvas.document().entities()[0].b, { 6000, 3500 }));
    click({ 507, 343 });
    CHECK(canvas.stage() == 1);
    click({ 522, 328 });
    CHECK(near(canvas.document().entities()[1].a, { 5100, 3600 }));
    CHECK(near(canvas.document().entities()[1].b, { 5300, 3800 }));
    click({ 700, 400 });
    QTest::keyClick(&window, Qt::Key_Escape);
    CHECK(canvas.stage() == 0 && canvas.count() == 2);
    click({ 700, 400 });
    QTest::mouseClick(&window, Qt::RightButton, Qt::NoModifier, { 700, 400 });
    CHECK(canvas.stage() == 0 && canvas.count() == 2);

    canvas.activeLayer = 1;
    const QPointF objectEndpoint(2000.25, 2000.75);
    CHECK(canvas.line(objectEndpoint.x(), objectEndpoint.y(), 3500.5, 2000.75));
    canvas.objectSnap = true;
    click(canvas.view().screen(objectEndpoint).toPoint() + QPoint(3, 2));
    click({ 650, 500 });
    CHECK(canvas.count() == 4);
    CHECK(near(canvas.document().entities()[3].a, objectEndpoint));
    CHECK(near(canvas.document().entities()[3].b, { 7000, 1500 }));

    canvas.activeLayer = 0;
    canvas.objectSnap = false;
    canvas.setTool("arc");
    click({ 500, 350 }); click({ 575, 350 }); click({ 500, 275 });
    CHECK(canvas.count() == 5 && canvas.stage() == 0);
    const cad::Entity createdArc = canvas.document().entities()[4];
    CHECK(createdArc.kind == cad::Kind::Arc && near(createdArc.a, { 5000, 3500 }));
    CHECK(near(createdArc.radius, 1000) && near(createdArc.startDegrees, 0) && near(createdArc.sweepDegrees, 90));
    canvas.activeLayer = 2;
    canvas.textValue = QString::fromUtf8("東京都 / 서울 / Café ㎡");
    canvas.setTool("text");
    click({ 575, 275 });
    CHECK(canvas.count() == 6);
    CHECK(canvas.document().entities()[5].kind == cad::Kind::Text);
    CHECK(canvas.document().entities()[5].text == canvas.textValue);
    CHECK(near(canvas.document().entities()[5].a, { 6000, 4500 }));

    canvas.setTool("select");
    click({ 545, 350 });
    CHECK(canvas.hasSelection());
    const cad::Entity beforeMove = canvas.document().entities()[0];
    CHECK(canvas.moveSelected(300, 200));
    CHECK(canvas.document().entities()[0].id == beforeMove.id);
    CHECK(near(canvas.document().entities()[0].a, beforeMove.a + QPointF(300, 200)));
    canvas.undo();
    CHECK(canvas.document().entities()[0] == beforeMove && canvas.redoAvailable());
    canvas.redo();
    CHECK(near(canvas.document().entities()[0].b, beforeMove.b + QPointF(300, 200)));
    canvas.selectNext();
    CHECK(canvas.hasSelection());
    QTest::keyClick(&window, Qt::Key_Delete);
    CHECK(canvas.count() == 5 && !canvas.hasSelection());
    canvas.undo();
    CHECK(canvas.count() == 6);
    canvas.setLayerVisible(0, false); canvas.setLayerVisible(1, false);
    canvas.selectNext();
    CHECK(canvas.hasSelection() && canvas.selectionInfo() == canvas.textValue);
    canvas.setLayerVisible(2, false);
    CHECK(!canvas.hasSelection());
    canvas.selectNext();
    CHECK(!canvas.hasSelection());
    const int beforeHiddenDraw=canvas.count();
    CHECK(!canvas.line(0,0,1000,0));
    CHECK(canvas.message()=="layerHidden" && canvas.count()==beforeHiddenDraw);
    for (int i = 0; i < 3; ++i) canvas.setLayerVisible(i, true);
    const QPointF beforePan = canvas.view().center;
    QTest::mousePress(&window, Qt::MiddleButton, Qt::NoModifier, { 300, 300 });
    QTest::mouseMove(&window, { 330, 315 });
    QTest::mouseRelease(&window, Qt::MiddleButton, Qt::NoModifier, { 330, 315 });
    CHECK(near(canvas.view().center, beforePan + QPointF(-400, 200)));
    const double beforeInvalidZoom = canvas.view().scale;
    canvas.zoomStep(std::numeric_limits<double>::quiet_NaN());
    canvas.zoomStep(-1);
    CHECK(canvas.view().scale == beforeInvalidZoom);

    const QString roundtrip = output.filePath("canvas-roundtrip.fresco");
    const QVector<cad::Entity> beforeSave = canvas.document().entities();
    CHECK(canvas.save(QUrl::fromLocalFile(roundtrip)));
    CHECK(!canvas.dirty());
    const QByteArray nativeBytes = read(roundtrip);
    CHECK(canvas.load(QUrl::fromLocalFile(roundtrip)));
    CHECK(canvas.document().entities() == beforeSave);
    CHECK(canvas.save(QUrl::fromLocalFile(roundtrip)));
    CHECK(read(roundtrip) == nativeBytes);
    CHECK(!canvas.save(QUrl("https://example.invalid/drawing.fresco")) && canvas.message() == "localOnly");
    CHECK(!canvas.load(QUrl("https://example.invalid/drawing.fresco")));
    CHECK(!canvas.save(QUrl::fromLocalFile(scratch.filePath("unsupported.jww"))));
    CHECK(canvas.document().entities() == beforeSave);

    const cad::Entity visible = line("visible-line", { 0, 0 }, { 10000, 7000 });
    const QString visibleNative = scratch.filePath("visible.fresco");
    CHECK(writeDocument(visibleNative, { visible }));
    CHECK(canvas.load(QUrl::fromLocalFile(visibleNative)));
    const QString baselinePdf = output.filePath("baseline-visible.pdf");
    CHECK(canvas.exportPdf(QUrl::fromLocalFile(baselinePdf)));
    CHECK(read(baselinePdf).startsWith("%PDF-"));
    cad::Entity hidden;
    hidden.id = "hidden-giant-text"; hidden.kind = cad::Kind::Text;
    hidden.a = { 900000000, 900000000 }; hidden.text = "HIDDEN"; hidden.textHeight = 1e9; hidden.layer = 2;
    const QString hiddenNative = scratch.filePath("hidden.fresco");
    CHECK(writeDocument(hiddenNative, { visible, hidden }));
    CHECK(canvas.load(QUrl::fromLocalFile(hiddenNative)));
    canvas.setLayerVisible(2, false);
    const QString visibleOnlyPdf = output.filePath("visible-only.pdf");
    CHECK(canvas.exportPdf(QUrl::fromLocalFile(visibleOnlyPdf)));
    const auto baselineStreams = graphicsStreams(read(baselinePdf));
    CHECK(!baselineStreams.isEmpty());
    CHECK(graphicsStreams(read(visibleOnlyPdf)) == baselineStreams);

    cad::Entity thin = sweep;
    thin.id = "thin-large-angle"; thin.a = { 0, 0 }; thin.radius = 10000000;
    thin.startDegrees = 360000010; thin.sweepDegrees = 0.02;
    const QString thinNative = output.filePath("thin-arc.fresco");
    CHECK(writeDocument(thinNative, { thin }));
    CHECK(canvas.load(QUrl::fromLocalFile(thinNative)));
    const QString thinPdf = output.filePath("thin-arc.pdf");
    CHECK(canvas.exportPdf(QUrl::fromLocalFile(thinPdf)));
    const auto thinStreams = graphicsStreams(read(thinPdf));
    CHECK(!thinStreams.isEmpty());
    CHECK(QRegularExpression("\\bc\\s").match(QString::fromLatin1(thinStreams.first())).hasMatch());

    hidden.a = { 0, 0 }; hidden.layer = 0;
    const QString oversizedNative = scratch.filePath("oversized-text.fresco");
    CHECK(writeDocument(oversizedNative, { hidden }));
    CHECK(canvas.load(QUrl::fromLocalFile(oversizedNative)));
    const QString rejectedPdf = scratch.filePath("must-not-exist.pdf");
    CHECK(!canvas.exportPdf(QUrl::fromLocalFile(rejectedPdf)));
    CHECK(canvas.message() == "pdfBounds" && !QFileInfo::exists(rejectedPdf));
    const QByteArray originalPdf = read(baselinePdf);
    CHECK(!canvas.exportPdf(QUrl::fromLocalFile(baselinePdf)));
    CHECK(canvas.message() == "pdfExists" && read(baselinePdf) == originalPdf);
    CHECK(!canvas.exportPdf(QUrl("https://example.invalid/drawing.pdf")));
    CHECK(!canvas.exportPdf(QUrl::fromLocalFile(scratch.filePath("drawing.png"))));

    const QString emptyNative = scratch.filePath("empty.fresco");
    cad::Document empty;
    CHECK(empty.save(emptyNative));
    CHECK(canvas.load(QUrl::fromLocalFile(emptyNative)));
    for (int i = 0; i < 3; ++i) canvas.setLayerVisible(i, true);
    canvas.sample();
    CHECK(canvas.count() > 50);
    CHECK(canvas.save(QUrl::fromLocalFile(output.filePath("canvas-sample.fresco"))));
    CHECK(canvas.exportPdf(QUrl::fromLocalFile(output.filePath("canvas-sample.pdf"))));
    QTextStream(stdout) << "PASS " << checks << " canvas checks (real input, geometry, snap, edit, native roundtrip, vector PDF)\n";
    return 0;
}
