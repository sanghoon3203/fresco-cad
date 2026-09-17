#pragma once

#include <QByteArray>
#include <QPointF>
#include <QStringList>
#include <QVector>

namespace cad {

enum class Kind { Line, Arc, Text };

// Millimetres, Cartesian Y up, double precision; supported world is ±1e9 mm.
struct Entity {
    QString id;
    Kind kind = Kind::Line;
    QPointF a, b;
    double radius = 1000;
    double startDegrees = 0;
    double sweepDegrees = 90;
    QString text;
    double textHeight = 180;
    int layer = 0;
    bool operator==(const Entity &other) const {
        // QPointF equality is fuzzy; document preservation requires exact doubles.
        return id == other.id && kind == other.kind && a.x() == other.a.x() &&
            a.y() == other.a.y() && b.x() == other.b.x() && b.y() == other.b.y() &&
            radius == other.radius && startDegrees == other.startDegrees &&
            sweepDegrees == other.sweepDegrees && text == other.text &&
            textHeight == other.textHeight && layer == other.layer;
    }
};

class Document {
public:
    const QVector<Entity> &entities() const { return entities_; }
    quint64 revision() const { return revision_; }
    bool canUndo() const { return cursor_ > 0; }
    bool canRedo() const { return cursor_ < history_.size(); }
    bool isDirty() const { return state_ != savedState_; }
    QString error() const { return error_; }
    QString path() const { return path_; }

    // Replacing an entity means removing and adding its ID in one transaction.
    // UI and future validated AI plans use this same atomic mutation boundary.
    bool apply(const QVector<Entity> &additions, const QStringList &removals,
               quint64 expectedRevision);
    bool undo();
    bool redo();
    bool save(const QString &path);
    bool load(const QString &path);

private:
    struct PositionedEntity { qsizetype index; Entity entity; };
    struct Delta {
        QVector<PositionedEntity> removed, added;
        quint64 beforeState, afterState;
    };
    bool fail(const QString &message) { error_ = message; return false; }
    void replay(const QVector<PositionedEntity> &remove,
                const QVector<PositionedEntity> &insert);

    QVector<Entity> entities_;
    // ponytail: history has no count cap but consumes RAM; add a disk journal
    // when measured long editing sessions require bounded memory or crash replay.
    QVector<Delta> history_;
    qsizetype cursor_ = 0;
    quint64 revision_ = 0, nextState_ = 0, state_ = 0, savedState_ = 0;
    QString error_, path_;
    QByteArray diskHash_;
};

} // namespace cad
