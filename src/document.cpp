#include "document.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLockFile>
#include <QSaveFile>
#include <QSet>
#include <QTemporaryFile>
#include <cmath>
#include <utility>

namespace cad {
namespace {
constexpr qsizetype MaxEntities = 100000;
constexpr qint64 MaxBytes = 64 * 1024 * 1024;
constexpr double WorldLimit = 1e9;

bool bounded(double value) { return std::isfinite(value) && std::abs(value) <= WorldLimit; }
bool bounded(QPointF value) { return bounded(value.x()) && bounded(value.y()); }

bool valid(const Entity &e)
{
    if (e.id.isEmpty() || e.id.size() > 128 || e.id.contains(QChar(0)) || !e.id.isValidUtf16() ||
        !bounded(e.a) || !bounded(e.b) || !bounded(e.radius) ||
        !bounded(e.startDegrees) || !bounded(e.sweepDegrees) ||
        !bounded(e.textHeight) || e.textHeight <= 0 || e.text.size() > 4096 ||
        e.text.contains(QChar(0)) || !e.text.isValidUtf16() || e.layer < 0 || e.layer > 2)
        return false;
    switch (e.kind) {
    case Kind::Line: return e.a.x() != e.b.x() || e.a.y() != e.b.y();
    case Kind::Arc:
        return e.radius > 0 && e.sweepDegrees != 0 && std::abs(e.sweepDegrees) <= 360 &&
               std::abs(e.a.x()) + e.radius <= WorldLimit &&
               std::abs(e.a.y()) + e.radius <= WorldLimit;
    case Kind::Text: return !e.text.isEmpty();
    }
    return false;
}

QJsonArray point(QPointF p) { return { p.x(), p.y() }; }

QByteArray encode(const QVector<Entity> &entities)
{
    QJsonArray items;
    for (const Entity &e : entities) {
        const QString kind = e.kind == Kind::Line ? "line" : e.kind == Kind::Arc ? "arc" : "text";
        items.append(QJsonObject { { "id", e.id }, { "kind", kind },
            { "a", point(e.a) }, { "b", point(e.b) }, { "radius", e.radius },
            { "startDegrees", e.startDegrees }, { "sweepDegrees", e.sweepDegrees },
            { "text", e.text }, { "textHeight", e.textHeight }, { "layer", e.layer } });
    }
    return QJsonDocument(QJsonObject { { "format", "fresco-cad" }, { "version", 1 },
        { "units", "mm" }, { "entities", items } }).toJson(QJsonDocument::Compact) + '\n';
}

bool exactKeys(const QJsonObject &object, const QStringList &keys)
{
    if (object.size() != keys.size()) return false;
    for (const QString &key : keys) if (!object.contains(key)) return false;
    return true;
}

bool parsePoint(const QJsonValue &value, QPointF &result)
{
    if (!value.isArray()) return false;
    const QJsonArray p = value.toArray();
    if (p.size() != 2 || !p[0].isDouble() || !p[1].isDouble()) return false;
    result = QPointF(p[0].toDouble(), p[1].toDouble());
    return bounded(result);
}

// Qt's JSON parser keeps the last duplicate key. Reject duplicates explicitly
// so an unsupported or conflicting value cannot disappear during parsing.
bool uniqueJsonKeys(const QByteArray &bytes)
{
    QVector<QSet<QString>> objects;
    for (qsizetype i = 0; i < bytes.size(); ++i) {
        const char c = bytes[i];
        if (c == '{') objects.append(QSet<QString>());
        else if (c == '}') objects.removeLast();
        else if (c == '"') {
            const qsizetype start = i++;
            bool escaped = false;
            while (i < bytes.size() && bytes[i] != '"') {
                if (bytes[i] == '\\') { escaped = true; ++i; }
                ++i;
            }
            qsizetype next = i + 1;
            while (next < bytes.size() && (bytes[next] == ' ' || bytes[next] == '\t' ||
                   bytes[next] == '\r' || bytes[next] == '\n')) ++next;
            if (next < bytes.size() && bytes[next] == ':') {
                const QByteArray token = bytes.mid(start, i - start + 1);
                const QString key = escaped
                    ? QJsonDocument::fromJson('[' + token + ']').array()[0].toString()
                    : QString::fromUtf8(token.constData() + 1, token.size() - 2);
                if (objects.isEmpty() || objects.last().contains(key)) return false;
                objects.last().insert(key);
            }
        }
    }
    return true;
}

bool decode(const QByteArray &bytes, QVector<Entity> &entities)
{
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(bytes, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject() ||
        !uniqueJsonKeys(bytes)) return false;
    const QJsonObject root = document.object();
    if (!exactKeys(root, { "format", "version", "units", "entities" }) ||
        !root["format"].isString() || root["format"].toString() != "fresco-cad" ||
        !root["version"].isDouble() || root["version"].toDouble() != 1 ||
        !root["units"].isString() || root["units"].toString() != "mm" ||
        !root["entities"].isArray()) return false;
    const QJsonArray items = root["entities"].toArray();
    if (items.size() > MaxEntities) return false;
    QVector<Entity> parsed;
    parsed.reserve(items.size());
    QSet<QString> ids;
    for (const QJsonValue &item : items) {
        if (!item.isObject()) return false;
        const QJsonObject o = item.toObject();
        if (!exactKeys(o, { "id", "kind", "a", "b", "radius", "startDegrees",
                            "sweepDegrees", "text", "textHeight", "layer" }) ||
            !o["id"].isString() || !o["kind"].isString() || !o["text"].isString()) return false;
        for (const QString &key : { "radius", "startDegrees", "sweepDegrees", "textHeight", "layer" })
            if (!o[key].isDouble() || !std::isfinite(o[key].toDouble())) return false;
        Entity e;
        e.id = o["id"].toString();
        const QString kind = o["kind"].toString();
        if (kind == "line") e.kind = Kind::Line;
        else if (kind == "arc") e.kind = Kind::Arc;
        else if (kind == "text") e.kind = Kind::Text;
        else return false;
        if (!parsePoint(o["a"], e.a) || !parsePoint(o["b"], e.b)) return false;
        e.radius = o["radius"].toDouble();
        e.startDegrees = o["startDegrees"].toDouble();
        e.sweepDegrees = o["sweepDegrees"].toDouble();
        e.text = o["text"].toString();
        e.textHeight = o["textHeight"].toDouble();
        const double layer = o["layer"].toDouble();
        if (layer < 0 || layer > 2 || layer != std::floor(layer)) return false;
        e.layer = int(layer);
        if (!valid(e) || ids.contains(e.id)) return false;
        ids.insert(e.id);
        parsed.append(e);
    }
    entities.swap(parsed);
    return true;
}

QString normalizedPath(const QString &path) { return QDir::cleanPath(QFileInfo(path).absoluteFilePath()); }
bool supportedPath(const QString &path) { return QFileInfo(path).suffix().compare("fresco", Qt::CaseInsensitive) == 0; }
QByteArray hash(const QByteArray &bytes) { return QCryptographicHash::hash(bytes, QCryptographicHash::Sha256); }

bool readBounded(const QString &path, QByteArray &bytes, QString &error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) { error = "File is missing or unreadable."; return false; }
    if (file.size() > MaxBytes) { error = "File exceeds 64 MiB."; return false; }
    bytes = file.read(MaxBytes + 1);
    if (bytes.size() > MaxBytes) { error = "File exceeds 64 MiB."; return false; }
    if (file.error() != QFileDevice::NoError) { error = "File is missing or unreadable."; return false; }
    return true;
}

bool atomicWrite(const QString &path, const QByteArray &bytes)
{
    QSaveFile file(path);
    file.setDirectWriteFallback(false);
    return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit();
}
} // namespace

bool Document::apply(const QVector<Entity> &additions, const QStringList &removals,
                     quint64 expectedRevision)
{
    if (expectedRevision != revision_) return fail("Stale document revision.");
    if (additions.isEmpty() && removals.isEmpty()) return fail("Invalid transaction.");
    QSet<QString> existing, removed;
    for (const Entity &e : entities_) existing.insert(e.id);
    for (const QString &id : removals) {
        if (!existing.contains(id) || removed.contains(id)) return fail("Invalid transaction.");
        removed.insert(id);
    }
    if (entities_.size() - removed.size() + additions.size() > MaxEntities)
        return fail("Entity limit exceeded.");
    QHash<QString, Entity> added;
    for (const Entity &e : additions) {
        if (!valid(e)) return fail("Invalid entity.");
        if (added.contains(e.id) || (existing.contains(e.id) && !removed.contains(e.id)))
            return fail("Invalid transaction.");
        added.insert(e.id, e);
    }

    Delta delta;
    delta.beforeState = state_;
    delta.afterState = nextState_ + 1;
    QVector<Entity> next;
    next.reserve(entities_.size() - removed.size() + additions.size());
    for (qsizetype i = 0; i < entities_.size(); ++i) {
        const Entity &e = entities_[i];
        if (!removed.contains(e.id)) { next.append(e); continue; }
        delta.removed.append({ i, e });
        if (added.contains(e.id)) {
            const Entity replacement = added.take(e.id);
            delta.added.append({ next.size(), replacement });
            next.append(replacement);
        }
    }
    for (const Entity &e : additions) {
        if (added.contains(e.id)) {
            delta.added.append({ next.size(), e });
            next.append(e);
        }
    }
    history_.resize(cursor_);
    history_.append(std::move(delta));
    ++cursor_;
    state_ = ++nextState_;
    ++revision_;
    entities_.swap(next);
    error_.clear();
    return true;
}

void Document::replay(const QVector<PositionedEntity> &remove,
                      const QVector<PositionedEntity> &insert)
{
    QSet<QString> ids;
    for (const PositionedEntity &entry : remove) ids.insert(entry.entity.id);
    QVector<Entity> next;
    next.reserve(entities_.size() - remove.size() + insert.size());
    qsizetype at = 0;
    // Merge in original positions in O(document + delta), including mass undo.
    for (const Entity &e : entities_) {
        if (ids.contains(e.id)) continue;
        while (at < insert.size() && insert[at].index == next.size())
            next.append(insert[at++].entity);
        next.append(e);
    }
    while (at < insert.size()) next.append(insert[at++].entity);
    entities_.swap(next);
    ++revision_;
    error_.clear();
}

bool Document::undo()
{
    if (!canUndo()) return fail("Nothing to undo.");
    const Delta &delta = history_[--cursor_];
    replay(delta.added, delta.removed);
    state_ = delta.beforeState;
    return true;
}

bool Document::redo()
{
    if (!canRedo()) return fail("Nothing to redo.");
    const Delta &delta = history_[cursor_++];
    replay(delta.removed, delta.added);
    state_ = delta.afterState;
    return true;
}

bool Document::load(const QString &requestedPath)
{
    if (!supportedPath(requestedPath)) return fail("Only .fresco files are supported.");
    const QString target = normalizedPath(requestedPath);
    QByteArray bytes;
    if (!readBounded(target, bytes, error_)) return false;
    QVector<Entity> parsed;
    if (!decode(bytes, parsed)) return fail("Unsupported or malformed document.");
    entities_.swap(parsed);
    history_.clear();
    cursor_ = 0;
    state_ = savedState_ = ++nextState_;
    ++revision_;
    path_ = target;
    diskHash_ = hash(bytes);
    error_.clear();
    return true;
}

bool Document::save(const QString &requestedPath)
{
    if (!supportedPath(requestedPath)) return fail("Only .fresco files are supported.");
    const QString target = normalizedPath(requestedPath);
    QLockFile lock(target + ".lock");
    if (!lock.tryLock(0)) return fail("File is locked by another writer.");
    const bool sameFile = target == path_;
    QByteArray previous;
    if (sameFile) {
        if (!readBounded(target, previous, error_) || hash(previous) != diskHash_)
            return fail("Document changed on disk.");
        QVector<Entity> verifiedPrevious;
        if (!decode(previous, verifiedPrevious)) return fail("Document changed on disk.");
    } else if (QFileInfo::exists(target)) {
        return fail("Refusing to overwrite another file.");
    }
    const QByteArray bytes = encode(entities_);
    if (bytes.size() > MaxBytes) return fail("File exceeds 64 MiB.");

    // QSaveFile is write-only. Stage once in a read/write temporary file so
    // verification checks bytes read from disk, then atomically commit them.
    QTemporaryFile staged(QFileInfo(target).dir().filePath(".fresco-save-XXXXXX"));
    if (!staged.open() || staged.write(bytes) != bytes.size() || !staged.flush() || !staged.seek(0))
        return fail("Could not verify temporary save.");
    const QByteArray verifiedBytes = staged.read(MaxBytes + 1);
    QVector<Entity> verifiedEntities;
    if (staged.error() != QFileDevice::NoError || verifiedBytes != bytes ||
        !decode(verifiedBytes, verifiedEntities) || verifiedEntities != entities_)
        return fail("Could not verify temporary save.");

    QByteArray current;
    if (sameFile) {
        if (!readBounded(target, current, error_) || hash(current) != diskHash_)
            return fail("Document changed on disk.");
        if (!atomicWrite(target + ".last-good", previous))
            return fail("Could not write last-good backup.");
    }
    if ((!sameFile && QFileInfo::exists(target)) ||
        (sameFile && (!readBounded(target, current, error_) || hash(current) != diskHash_)))
        return fail("Document changed on disk.");
    // Cooperative writers hold this lock. Uncooperative external writers can
    // still race the final hash/rename; no portable filesystem CAS is available.
    if (!atomicWrite(target, verifiedBytes)) return fail("Could not commit document.");
    path_ = target;
    diskHash_ = hash(verifiedBytes);
    savedState_ = state_;
    error_.clear();
    return true;
}

} // namespace cad
