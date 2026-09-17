#include "document.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLockFile>
#include <QTemporaryDir>
#include <QTextStream>
#include <limits>

namespace {
int checks = 0;
bool check(bool value, const char *message)
{
    ++checks;
    if (!value) QTextStream(stderr) << "FAIL " << message << '\n';
    return value;
}
#define CHECK(condition) do { if (!check(bool(condition), #condition)) return 1; } while (false)

QByteArray read(const QString &path)
{
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
}
bool write(const QString &path, const QByteArray &bytes)
{
    QFile file(path);
    return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.flush();
}
cad::Entity line(QString id, QPointF a = { 0, 0 }, QPointF b = { 1000, 0 })
{
    cad::Entity result;
    result.id = id;
    result.a = a;
    result.b = b;
    return result;
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTemporaryDir directory;
    CHECK(directory.isValid());
    const QString path = directory.filePath("precision.fresco");
    cad::Document document;
    CHECK(document.entities().isEmpty() && !document.isDirty());
    CHECK(!document.canUndo() && !document.canRedo());
    CHECK(!document.undo() && !document.redo());

    cad::Entity exact = line("精密線", { 123456789.12345679, -0.000000123456789 },
        { 123456789.12345779, 9.876543210123456 });
    cad::Entity arc;
    arc.id = "arc-α";
    arc.kind = cad::Kind::Arc;
    arc.a = { -12.345678901234567, 765.4321098765432 };
    arc.radius = 340.1234567890123;
    arc.startDegrees = -17.1234567890123;
    arc.sweepDegrees = -300.1234567890123;
    arc.layer = 1;
    cad::Entity text;
    text.id = "text";
    text.kind = cad::Kind::Text;
    text.a = { 42.12345678912345, 100.987654321 };
    text.text = QString::fromUtf8("東京都・全角Ａ／半角A\n서울: 검토 완료 — Café 🏠\t\"quoted\" \\ slash");
    text.textHeight = 180.123456789123;
    text.layer = 2;
    const QVector<cad::Entity> baseline { exact, arc, text };
    CHECK(document.apply(baseline, {}, document.revision()));
    CHECK(document.isDirty() && document.canUndo());
    CHECK(document.save(path));
    CHECK(!document.isDirty());
    CHECK(document.path() == path);
    const QByteArray originalBytes = read(path);
    CHECK(!originalBytes.isEmpty());

    cad::Document loaded;
    CHECK(loaded.load(path));
    CHECK(loaded.entities() == baseline && !loaded.isDirty());
    CHECK(loaded.save(path));
    CHECK(read(path) == originalBytes);
    CHECK(read(path + ".last-good") == originalBytes);
    CHECK(document.undo());
    CHECK(document.entities().isEmpty() && document.isDirty());
    CHECK(document.redo());
    CHECK(document.entities() == baseline && !document.isDirty());

    cad::Entity moved = exact;
    moved.a += QPointF(200, -300);
    moved.b += QPointF(200, -300);
    const quint64 beforeMove = document.revision();
    CHECK(document.apply({ moved }, { exact.id }, beforeMove));
    CHECK(document.entities()[0] == moved && document.entities()[1] == arc);
    CHECK(document.isDirty());
    CHECK(!document.apply({ line("stale") }, {}, beforeMove));
    CHECK(document.error() == "Stale document revision.");
    CHECK(document.undo() && !document.isDirty());
    CHECK(document.redo() && document.isDirty());
    CHECK(document.save(path));
    CHECK(read(path + ".last-good") == originalBytes);
    CHECK(!document.isDirty());
    CHECK(document.undo() && document.isDirty());
    CHECK(document.apply({ line("branch") }, {}, document.revision()));
    CHECK(!document.canRedo() && document.isDirty());
    CHECK(document.undo() && document.isDirty());
    CHECK(document.entities() == baseline);

    const quint64 goodRevision = document.revision();
    const QVector<cad::Entity> goodEntities = document.entities();
    CHECK(!document.apply({ line("x"), line("x") }, {}, goodRevision));
    CHECK(!document.apply({ exact }, {}, goodRevision));
    CHECK(!document.apply({}, { "missing" }, goodRevision));
    CHECK(!document.apply({}, { exact.id, exact.id }, goodRevision));
    CHECK(!document.apply({}, {}, goodRevision));
    cad::Entity invalid = line("invalid");
    invalid.a.setX(std::numeric_limits<double>::infinity());
    CHECK(!document.apply({ invalid }, { arc.id }, goodRevision));
    invalid.a.setX(std::numeric_limits<double>::quiet_NaN());
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid = line("zero", { 1, 2 }, { 1, 2 });
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid = arc;
    invalid.id = "invalid";
    invalid.sweepDegrees = 361;
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid.sweepDegrees = 0;
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid.sweepDegrees = 90;
    invalid.radius = -1;
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid = text;
    invalid.id = "invalid";
    invalid.text = QString(4097, QChar('a'));
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid.text = QString(QChar(0xd800));
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid = line("invalid");
    invalid.layer = 3;
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    invalid.layer = 0;
    invalid.b.setX(1e9 + 1);
    CHECK(!document.apply({ invalid }, {}, goodRevision));
    CHECK(document.revision() == goodRevision && document.entities() == goodEntities);
    // A nonzero line at large coordinates must survive QPointF's fuzzy equality.
    CHECK(document.apply({ line("tiny", { 999999999, 0 }, { 999999999.000001, 0 }) }, {}, goodRevision));
    CHECK(document.undo() && document.entities() == goodEntities);

    const QString corrupt = directory.filePath("corrupt.fresco");
    CHECK(write(corrupt, "{broken"));
    CHECK(!document.load(corrupt));
    CHECK(document.entities() == goodEntities && document.path() == path);
    QJsonObject root = QJsonDocument::fromJson(originalBytes).object();
    root["version"] = 2;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    root["version"] = 1;
    root["futureDimension"] = true;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    root.remove("futureDimension");
    root["version"] = "1";
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    root["version"] = 1;
    QJsonArray items = root["entities"].toArray();
    QJsonObject first = items[0].toObject();
    first["layer"] = 0.5;
    items[0] = first;
    root["entities"] = items;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    first["layer"] = 0;
    first["radius"] = QJsonValue::Null;
    items[0] = first;
    root["entities"] = items;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    CHECK(write(corrupt, QByteArray("{\"version\":2,") + originalBytes.mid(1)));
    CHECK(!document.load(corrupt));
    CHECK(write(corrupt, QByteArray("{\"\\u0076ersion\":2,") + originalBytes.mid(1)));
    CHECK(!document.load(corrupt));
    for (const QByteArray &badUtf8 : { QByteArray::fromHex("c0af"), QByteArray::fromHex("80"),
                                     QByteArray::fromHex("eda080"), QByteArray::fromHex("f4908080") }) {
        QByteArray hostile = originalBytes;
        hostile.replace(QString::fromUtf8("東京都").toUtf8(), badUtf8);
        CHECK(hostile != originalBytes);
        CHECK(write(corrupt, hostile));
        CHECK(!document.load(corrupt));
    }
    QByteArray unpairedSurrogate = originalBytes;
    unpairedSurrogate.replace(QString::fromUtf8("東京都").toUtf8(), "\\ud800");
    CHECK(write(corrupt, unpairedSurrogate));
    CHECK(!document.load(corrupt));
    root = QJsonDocument::fromJson(originalBytes).object();
    items = root["entities"].toArray();
    items.append(items[0]);
    root["entities"] = items;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    items.removeLast();
    first = items[0].toObject();
    first["unsupportedScale"] = 50;
    items[0] = first;
    root["entities"] = items;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    first.remove("unsupportedScale");
    first.remove("radius");
    items[0] = first;
    root["entities"] = items;
    CHECK(write(corrupt, QJsonDocument(root).toJson()));
    CHECK(!document.load(corrupt));
    CHECK(document.entities() == goodEntities);
    QFile oversized(corrupt);
    CHECK(oversized.open(QIODevice::WriteOnly));
    CHECK(oversized.resize(64LL * 1024 * 1024 + 1));
    oversized.close();
    CHECK(!document.load(corrupt));
    CHECK(document.error() == "File exceeds 64 MiB.");
    CHECK(document.entities() == goodEntities);

    CHECK(!document.save(directory.filePath("drawing.jww")));
    CHECK(!document.load(directory.filePath("drawing.dwg")));
    cad::Document unrelated;
    const QByteArray beforeConflict = read(path);
    CHECK(!unrelated.save(path));
    CHECK(unrelated.error() == "Refusing to overwrite another file.");
    CHECK(read(path) == beforeConflict);
    const QByteArray external = "external content must survive";
    CHECK(write(path, external));
    CHECK(!document.save(path));
    CHECK(document.error() == "Document changed on disk.");
    CHECK(read(path) == external && document.entities() == goodEntities);
    CHECK(write(path, beforeConflict));
    CHECK(document.save(path));
    CHECK(read(path + ".last-good") == beforeConflict);
    const QString recoveredPath = directory.filePath("recovered.fresco");
    CHECK(QFile::copy(path + ".last-good", recoveredPath));
    cad::Document recovered;
    CHECK(recovered.load(recoveredPath));
    CHECK(recovered.entities()[0] == moved && recovered.entities().size() == 3);
    const QString locked = directory.filePath("locked.fresco");
    QLockFile lock(locked + ".lock");
    CHECK(lock.tryLock(0));
    CHECK(!document.save(locked));
    CHECK(document.error() == "File is locked by another writer.");
    const QString blockedBackup = directory.filePath("backup-failure.fresco");
    cad::Document protectedFile;
    CHECK(protectedFile.apply({ exact }, {}, 0));
    CHECK(protectedFile.save(blockedBackup));
    const QByteArray protectedBytes = read(blockedBackup);
    CHECK(QDir().mkdir(blockedBackup + ".last-good"));
    CHECK(protectedFile.apply({ arc }, {}, protectedFile.revision()));
    CHECK(!protectedFile.save(blockedBackup));
    CHECK(protectedFile.error() == "Could not write last-good backup.");
    CHECK(read(blockedBackup) == protectedBytes && protectedFile.isDirty());

    // Multi-entity deltas preserve draw order through replacement/removal/append.
    cad::Document ordering;
    const QVector<cad::Entity> four { line("a"), line("b"), line("c"), line("d") };
    CHECK(ordering.apply(four, {}, 0));
    cad::Entity b = line("b", { 20, 30 }, { 40, 50 });
    CHECK(ordering.apply({ line("e"), b }, { "b", "d" }, ordering.revision()));
    const QVector<cad::Entity> expected { four[0], b, four[2], line("e") };
    CHECK(ordering.entities() == expected);
    CHECK(ordering.undo() && ordering.entities() == four);
    CHECK(ordering.redo() && ordering.entities() == expected);
    QVector<cad::Entity> maximum;
    maximum.reserve(100001);
    for (int i = 0; i < 100001; ++i) maximum.append(line(QString::number(i)));
    cad::Document many;
    CHECK(!many.apply(maximum, {}, 0));
    CHECK(many.entities().isEmpty() && many.revision() == 0);
    maximum.removeLast();
    CHECK(many.apply(maximum, {}, 0));
    CHECK(many.entities().size() == 100000);
    CHECK(many.undo() && many.entities().isEmpty());
    CHECK(many.redo() && many.entities() == maximum);

    QTextStream(stdout) << "PASS " << checks << " document checks (precision, transactions, history, safe save, hostile files)\n";
    return 0;
}
