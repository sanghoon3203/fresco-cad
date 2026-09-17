#pragma once
#include "geometry.h"
#include <QQuickItem>
#include <QUrl>
#include <QElapsedTimer>

class CadCanvas : public QQuickItem {
    Q_OBJECT
    Q_PROPERTY(QString tool READ tool WRITE setTool NOTIFY changed)
    Q_PROPERTY(int count READ count NOTIFY changed)
    Q_PROPERTY(int stage READ stage NOTIFY changed)
    Q_PROPERTY(bool dirty READ dirty NOTIFY changed)
    Q_PROPERTY(bool undoAvailable READ undoAvailable NOTIFY changed)
    Q_PROPERTY(bool redoAvailable READ redoAvailable NOTIFY changed)
    Q_PROPERTY(bool hasSelection READ hasSelection NOTIFY changed)
    Q_PROPERTY(QString message READ message NOTIFY changed)
    Q_PROPERTY(QString fileName READ fileName NOTIFY changed)
    Q_PROPERTY(QUrl fileUrl READ fileUrl NOTIFY changed)
    Q_PROPERTY(QString coordinates READ coordinates NOTIFY changed)
    Q_PROPERTY(QString selectionInfo READ selectionInfo NOTIFY changed)
    Q_PROPERTY(int activeLayer MEMBER activeLayer NOTIFY changed)
    Q_PROPERTY(bool gridSnap MEMBER gridSnap NOTIFY changed)
    Q_PROPERTY(bool objectSnap MEMBER objectSnap NOTIFY changed)
    Q_PROPERTY(QString textValue MEMBER textValue NOTIFY changed)
    Q_PROPERTY(QVariantMap palette MEMBER palette NOTIFY changed)
public:
    explicit CadCanvas(QQuickItem *parent=nullptr);
    QString tool() const {return m_tool;} void setTool(const QString &s);
    int count() const {return m_doc.entities().size();} int stage() const {return m_points.size();}
    bool dirty() const {return m_doc.isDirty();}
    bool undoAvailable() const {return m_doc.canUndo();} bool redoAvailable() const {return m_doc.canRedo();}
    bool hasSelection() const {return !m_selected.isEmpty();}
    QString message() const {return m_message;} QString fileName() const;
    QUrl fileUrl() const {return m_doc.path().isEmpty()?QUrl():QUrl::fromLocalFile(m_doc.path());}
    QString coordinates() const; QString selectionInfo() const;
    int activeLayer=0; bool gridSnap=true,objectSnap=true; QString textValue;
    QVariantMap palette;
    Q_INVOKABLE void undo(); Q_INVOKABLE void redo(); Q_INVOKABLE void cancel();
    Q_INVOKABLE void removeSelected(); Q_INVOKABLE bool moveSelected(double dx,double dy);
    Q_INVOKABLE bool line(double x1,double y1,double x2,double y2);
    Q_INVOKABLE bool save(QUrl url); Q_INVOKABLE bool load(QUrl url);
    Q_INVOKABLE bool exportPdf(QUrl url);
    Q_INVOKABLE void fit(); Q_INVOKABLE void zoomStep(double factor);
    Q_INVOKABLE void setLayerVisible(int layer,bool visible);
    Q_INVOKABLE void sample(); Q_INVOKABLE void benchmarkScene(int count);
    Q_INVOKABLE void selectNext();
    const cad::Document &document() const {return m_doc;}
    const cad::View &view() const {return m_view;}
    bool layerVisible(int i) const {return m_visible[i];}
signals: void changed();
protected:
    QSGNode *updatePaintNode(QSGNode *,UpdatePaintNodeData *) override;
    void geometryChange(const QRectF &,const QRectF &) override;
    void mousePressEvent(QMouseEvent *) override;
    void mouseMoveEvent(QMouseEvent *) override;
    void mouseReleaseEvent(QMouseEvent *) override;
    void hoverMoveEvent(QHoverEvent *) override;
    void wheelEvent(QWheelEvent *) override;
    void keyPressEvent(QKeyEvent *) override;
private:
    cad::Document m_doc; cad::View m_view;
    QElapsedTimer m_inputActivity;
    QMetaObject::Connection m_frameConnection;
    QString m_tool="select",m_selected,m_message="ready";
    QVector<QPointF> m_points; QPointF m_cursor,m_panPosition,m_pointerPosition;
    bool m_panning=false,m_snapped=false,m_visible[3]{true,true,true};
    QPointF snap(QPointF screen); void pointer(QPointF screen);
    bool commit(const QVector<cad::Entity> &,const QStringList &removals={});
    void refresh(); const cad::Entity *selected() const;
    QColor color(const char *role) const;
};
