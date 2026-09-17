#include "canvas.h"
#include <QSGGeometryNode>
#include <QSGFlatColorMaterial>
#include <QSGTextNode>
#include <QSGTransformNode>
#include <QQuickWindow>
#include <QTextLayout>
#include <QMouseEvent>
#include <QKeyEvent>
#include <QWheelEvent>
#include <QFileInfo>
#include <QSaveFile>
#include <QLockFile>
#include <QPdfWriter>
#include <QPainter>
#include <QPainterPath>
#include <QFontMetricsF>
#include <QUuid>
#include <QGuiApplication>

using namespace cad;
static Entity newEntity(Kind kind,int layer) { Entity e; e.id=QUuid::createUuid().toString(QUuid::WithoutBraces);e.kind=kind;e.layer=layer;return e; }
static void segment(QVector<QPointF> &v,QPointF a,QPointF b,double width) {
    const auto d=b-a; const double length=std::hypot(d.x(),d.y()); if(length<1e-10)return;
    const QPointF n(-d.y()*width/(2*length),d.x()*width/(2*length));
    v << a+n << a-n << b+n << b+n << a-n << b-n;
}
static void appendGeometry(QSGNode *root,const QVector<QPointF> &points,QColor color) {
    if(points.isEmpty())return;
    auto *node=new QSGGeometryNode;
    auto *geometry=new QSGGeometry(QSGGeometry::defaultAttributes_Point2D(),points.size());
    geometry->setDrawingMode(QSGGeometry::DrawTriangles);
    auto *vertices=geometry->vertexDataAsPoint2D();
    for(int i=0;i<points.size();++i)vertices[i].set(float(points[i].x()),float(points[i].y()));
    auto *material=new QSGFlatColorMaterial; material->setColor(color);
    node->setGeometry(geometry);node->setFlag(QSGNode::OwnsGeometry);
    node->setMaterial(material);node->setFlag(QSGNode::OwnsMaterial);root->appendChildNode(node);
}
static void shape(QVector<QPointF> &v,const Entity &e,const View &view,double width) {
    if(e.kind==Kind::Line){segment(v,view.screen(e.a),view.screen(e.b),width);return;}
    if(e.kind!=Kind::Arc)return;
    const double pixels=e.radius*view.scale;
    // Target sagitta 0.35 logical px, capped at 16384 segments; saved arcs remain analytic.
    const double step=pixels>0.35?2*std::acos(std::clamp(1-0.35/pixels,-1.0,1.0)):pi/2;
    const int n=std::clamp(int(std::ceil(std::abs(e.sweepDegrees)*pi/180/step)),2,16384);
    const double start=positiveDegrees(e.startDegrees);
    QPointF previous=view.screen(arcPoint(e,start));
    for(int i=1;i<=n;++i){auto next=view.screen(arcPoint(e,start+e.sweepDegrees*i/n));segment(v,previous,next,width);previous=next;}
}
CadCanvas::CadCanvas(QQuickItem *parent):QQuickItem(parent) {
    setFlag(ItemHasContents,true);setFlag(ItemIsFocusScope,true);setAcceptedMouseButtons(Qt::AllButtons);
    setAcceptHoverEvents(true);setActiveFocusOnTab(true);setClip(true);
    connect(this,&QQuickItem::windowChanged,this,[this](QQuickWindow *window){
        disconnect(m_frameConnection);
        m_inputActivity.invalidate();
        if(window)m_frameConnection=connect(window,&QQuickWindow::afterAnimating,this,[this,window]{
            // Keep native display updates running through a short input burst, then return to idle.
            // No coordinate interpolation or application timer drives these frames.
            if(isVisible()&&window->isExposed()&&m_inputActivity.isValid()&&m_inputActivity.elapsed()<50)
                window->update();
        });
    });
}
QColor CadCanvas::color(const char *role) const {return QColor(palette.value(QString::fromLatin1(role),"#24384b").toString());}
void CadCanvas::refresh(){emit changed();update();}
QString CadCanvas::fileName() const {return m_doc.path().isEmpty()?QString():QFileInfo(m_doc.path()).fileName();}
QString CadCanvas::coordinates() const {return QString::asprintf("X  %.3f     Y  %.3f   mm",m_cursor.x(),m_cursor.y());}
const Entity *CadCanvas::selected() const {if(m_selected.isEmpty())return nullptr;for(const auto &e:m_doc.entities())if(e.id==m_selected)return &e;return nullptr;}
QString CadCanvas::selectionInfo() const {
    const auto *e=selected();if(!e)return {};
    if(e->kind==Kind::Line)return QString::asprintf("%.3f mm",distance(e->a,e->b));
    if(e->kind==Kind::Arc)return QString::asprintf("R %.3f mm  /  %.3f°",e->radius,e->sweepDegrees);
    return e->text;
}
void CadCanvas::setTool(const QString &s){if(s!="select"&&s!="line"&&s!="arc"&&s!="text"&&s!="pan")return;m_tool=s;cancel();}
void CadCanvas::cancel(){m_points.clear();m_message="ready";m_panning=false;refresh();}
bool CadCanvas::commit(const QVector<Entity> &add,const QStringList &remove){
    for(const auto &e:add)if(e.layer>=0&&e.layer<3&&!m_visible[e.layer]){m_message="layerHidden";refresh();return false;}
    const bool ok=m_doc.apply(add,remove,m_doc.revision());m_message=ok?"changed":m_doc.error();refresh();return ok;
}
void CadCanvas::undo(){m_points.clear();m_selected.clear();m_message=m_doc.undo()?"undone":m_doc.error();refresh();}
void CadCanvas::redo(){m_points.clear();m_selected.clear();m_message=m_doc.redo()?"redone":m_doc.error();refresh();}
bool CadCanvas::line(double x1,double y1,double x2,double y2){auto e=newEntity(Kind::Line,activeLayer);e.a={x1,y1};e.b={x2,y2};return commit({e});}
bool CadCanvas::moveSelected(double dx,double dy){const auto *e=selected();if(!e)return false;auto moved=*e;moved.a+=QPointF(dx,dy);if(e->kind==Kind::Line)moved.b+=QPointF(dx,dy);return commit({moved},{e->id});}
void CadCanvas::removeSelected(){if(!m_selected.isEmpty()){commit({},{m_selected});m_selected.clear();refresh();}}
bool CadCanvas::save(QUrl url){if(!url.isLocalFile()){m_message="localOnly";refresh();return false;}const bool ok=m_doc.save(url.toLocalFile());m_message=ok?"saved":m_doc.error();refresh();return ok;}
bool CadCanvas::load(QUrl url){if(!url.isLocalFile()){m_message="localOnly";refresh();return false;}const bool ok=m_doc.load(url.toLocalFile());m_message=ok?"loaded":m_doc.error();if(ok){m_selected.clear();m_points.clear();fit();}refresh();return ok;}
void CadCanvas::setLayerVisible(int layer,bool visible){if(layer<0||layer>2)return;m_visible[layer]=visible;const auto *e=selected();if(e&&!m_visible[e->layer])m_selected.clear();refresh();}
void CadCanvas::selectNext(){
    const auto &entities=m_doc.entities();if(entities.isEmpty())return;int start=-1;
    for(int i=0;i<entities.size();++i)if(entities[i].id==m_selected){start=i;break;}
    for(int i=1;i<=entities.size();++i){const auto &e=entities[(start+i)%entities.size()];if(m_visible[e.layer]){m_selected=e.id;refresh();return;}}
}
void CadCanvas::geometryChange(const QRectF &now,const QRectF &old){QQuickItem::geometryChange(now,old);m_view.size=now.size();update();}
QPointF CadCanvas::snap(QPointF screen){
    auto p=m_view.world(screen);m_snapped=false;
    if(objectSnap){
        double best=10/m_view.scale;QPointF nearest=p;
        // ponytail: O(n) scan without per-entity allocation; index if measured input latency needs it.
        auto consider=[&](QPointF q){const double d=distance(p,q);if(d<best){best=d;nearest=q;m_snapped=true;}};
        for(const auto &e:m_doc.entities())if(m_visible[e.layer]){
            consider(e.a);
            if(e.kind==Kind::Line)consider(e.b);
            if(e.kind==Kind::Arc){const double start=positiveDegrees(e.startDegrees);consider(arcPoint(e,start));consider(arcPoint(e,start+e.sweepDegrees));}
        }
        if(m_snapped)return nearest;
    }
    if(gridSnap)return {std::round(p.x()/100)*100,std::round(p.y()/100)*100};
    return p;
}
void CadCanvas::pointer(QPointF screen){m_inputActivity.start();m_pointerPosition=screen;m_cursor=snap(screen);refresh();}
void CadCanvas::mousePressEvent(QMouseEvent *ev){
    forceActiveFocus();
    if(ev->button()==Qt::MiddleButton||m_tool=="pan"){m_panning=true;m_panPosition=ev->position();ev->accept();return;}
    if(ev->button()==Qt::RightButton){cancel();ev->accept();return;}
    if(ev->button()!=Qt::LeftButton)return;
    pointer(ev->position());
    if(m_tool=="select"){
        double best=10/m_view.scale;m_selected.clear();const auto p=m_view.world(ev->position());
        for(const auto &e:m_doc.entities())if(m_visible[e.layer]){const double d=entityDistance(p,e);if(d<best){best=d;m_selected=e.id;}}
        m_message=m_selected.isEmpty()?"selectionEmpty":"selected";
    }else if(m_tool=="text"){
        auto e=newEntity(Kind::Text,activeLayer);e.a=m_cursor;e.text=textValue;commit({e});
    }else{
        m_points<<m_cursor;
        if(m_tool=="line"&&m_points.size()==2){line(m_points[0].x(),m_points[0].y(),m_points[1].x(),m_points[1].y());m_points.clear();}
        if(m_tool=="arc"&&m_points.size()==3){
            auto e=newEntity(Kind::Arc,activeLayer);e.a=m_points[0];e.radius=distance(e.a,m_points[1]);
            e.startDegrees=angle(e.a,m_points[1]);e.sweepDegrees=positiveDegrees(angle(e.a,m_points[2])-e.startDegrees);
            commit({e});m_points.clear();
        }
    }
    refresh();ev->accept();
}
void CadCanvas::mouseMoveEvent(QMouseEvent *ev){
    if(m_panning){const auto d=ev->position()-m_panPosition;m_view.center+=QPointF(-d.x(),d.y())/m_view.scale;m_panPosition=ev->position();pointer(ev->position());}
    else pointer(ev->position());ev->accept();
}
void CadCanvas::mouseReleaseEvent(QMouseEvent *ev){m_panning=false;ev->accept();}
void CadCanvas::hoverMoveEvent(QHoverEvent *ev){pointer(ev->position());}
void CadCanvas::wheelEvent(QWheelEvent *ev){
    if(!ev->pixelDelta().isNull()&&!(ev->modifiers()&Qt::ControlModifier))m_view.center+=QPointF(-ev->pixelDelta().x(),ev->pixelDelta().y())/m_view.scale;
    else{const double delta=ev->pixelDelta().isNull()?ev->angleDelta().y():ev->pixelDelta().y()*4;m_view.zoom(ev->position(),std::exp(std::clamp(delta,-480.0,480.0)/600));}
    pointer(ev->position());ev->accept();
}
void CadCanvas::zoomStep(double factor){if(!std::isfinite(factor)||factor<=0)return;m_view.zoom({width()/2,height()/2},factor);pointer(m_pointerPosition);}
void CadCanvas::keyPressEvent(QKeyEvent *ev){
    if(ev->matches(QKeySequence::Undo))undo();else if(ev->matches(QKeySequence::Redo))redo();
    else if(ev->key()==Qt::Key_Escape)cancel();else if(ev->key()==Qt::Key_Delete||ev->key()==Qt::Key_Backspace)removeSelected();
    else if(ev->key()==Qt::Key_N)selectNext();else if(ev->key()==Qt::Key_L)setTool("line");else if(ev->key()==Qt::Key_A)setTool("arc");
    else if(ev->key()==Qt::Key_T)setTool("text");else if(ev->key()==Qt::Key_V)setTool("select");else if(ev->key()==Qt::Key_F)fit();
    else if(ev->key()==Qt::Key_Plus||ev->key()==Qt::Key_Equal)zoomStep(1.2);else if(ev->key()==Qt::Key_Minus)zoomStep(1/1.2);
    else if(ev->key()==Qt::Key_Left||ev->key()==Qt::Key_Right||ev->key()==Qt::Key_Up||ev->key()==Qt::Key_Down){m_view.center+=QPointF(ev->key()==Qt::Key_Left?-100:ev->key()==Qt::Key_Right?100:0,ev->key()==Qt::Key_Up?100:ev->key()==Qt::Key_Down?-100:0);pointer(m_pointerPosition);}
    else{QQuickItem::keyPressEvent(ev);return;}ev->accept();
}
static QRectF bounds(const QVector<Entity> &entities){
    if(entities.isEmpty())return {0,0,10000,7000};
    double left=1e30,right=-1e30,bottom=1e30,top=-1e30;
    auto add=[&](QPointF p){left=std::min(left,p.x());right=std::max(right,p.x());bottom=std::min(bottom,p.y());top=std::max(top,p.y());};
    for(const auto &e:entities){add(e.a);if(e.kind==Kind::Line)add(e.b);else if(e.kind==Kind::Arc){add(e.a-QPointF(e.radius,e.radius));add(e.a+QPointF(e.radius,e.radius));}else{add(e.a+QPointF(e.text.size()*e.textHeight,e.textHeight*1.5));}}
    return QRectF(QPointF(left,bottom),QPointF(right,top));
}
void CadCanvas::fit(){const auto b=bounds(m_doc.entities());m_view.center=b.center();m_view.scale=std::clamp(std::min(std::max(1.0,width()-160)/std::max(1.0,b.width()),std::max(1.0,height()-140)/std::max(1.0,b.height())),0.00001,20.0);pointer(m_pointerPosition);}
void CadCanvas::sample(){
    if(count())return;QVector<Entity> list;
    auto line=[&](double x,double y,double u,double v,int layer=0){auto e=newEntity(Kind::Line,layer);e.a={x,y};e.b={u,v};list<<e;};
    auto rect=[&](double x,double y,double w,double h,int layer=0){line(x,y,x+w,y,layer);line(x+w,y,x+w,y+h,layer);line(x+w,y+h,x,y+h,layer);line(x,y+h,x,y,layer);};
    rect(0,0,10000,7000);rect(150,150,9700,6700);line(6000,150,6000,4300);line(6150,150,6150,4300);line(6000,5300,6000,6850);line(6150,5300,6150,6850);
    line(6150,3500,9850,3500);line(6150,3650,9850,3650);
    for(int i=0;i<3;++i){rect(900+i*1500,4400,1100,650,1);rect(900+i*1500,5350,1100,650,1);}
    rect(7300,4500,1500,1200,1);rect(7000,1000,2100,800,1);
    for(int i=0;i<4;++i){rect(250+i*2400,100,300,350);rect(250+i*2400,6550,300,350);}
    auto arc=newEntity(Kind::Arc,0);arc.a={6000,4300};arc.radius=1000;arc.startDegrees=0;arc.sweepDegrees=90;list<<arc;line(6000,4300,7000,4300);
    auto label=[&](double x,double y,const QString &value){auto e=newEntity(Kind::Text,2);e.a={x,y};e.text=value;list<<e;};
    label(1000,3400,QStringLiteral("執務室 / WORKSPACE"));label(7000,6200,QStringLiteral("会議室"));label(7050,2450,QStringLiteral("ラウンジ"));
    label(0,7600,QStringLiteral("01   平面図 / SYNTHETIC SAMPLE"));label(3650,-650,QStringLiteral("10 000 mm"));
    line(0,-350,10000,-350,2);line(0,-500,0,-200,2);line(10000,-500,10000,-200,2);
    commit(list);fit();m_message="sampleLoaded";refresh();
}
void CadCanvas::benchmarkScene(int n){
    n=std::clamp(n,0,100000);QVector<Entity> list;QStringList removals;for(const auto &e:m_doc.entities())removals<<e.id;
    for(int i=0;i<n;++i){auto e=newEntity(i%100==0?Kind::Text:i%5==0?Kind::Arc:Kind::Line,i%3);e.a={double(i%400)*30,double(i/400)*30};e.b=e.a+QPointF(22,20);e.radius=12;e.text=QStringLiteral("寸法");e.textHeight=15;list<<e;}
    commit(list,removals);fit();
}
namespace {
// Render-thread-only state. Qt owns the root and releases the whole cache on scene invalidation.
struct CanvasScene final : QSGNode {
    QSGNode *grid=new QSGNode,*drawing=new QSGNode,*overlay=new QSGNode;
    View view;
    quint64 revision=0;
    int visibleMask=0;
    QString selection;
    QVariantMap palette;
    bool initialized=false;
    CanvasScene(){appendChildNode(grid);appendChildNode(drawing);appendChildNode(overlay);}
};
void clearChildren(QSGNode *node){while(auto *child=node->firstChild()){node->removeChildNode(child);delete child;}}
}
QSGNode *CadCanvas::updatePaintNode(QSGNode *old,UpdatePaintNodeData *){
    auto *root=old?static_cast<CanvasScene *>(old):new CanvasScene;
    // Compare scalar doubles exactly: QPointF equality is fuzzy near large world coordinates.
    const bool viewChanged=!root->initialized || root->view.center.x()!=m_view.center.x() || root->view.center.y()!=m_view.center.y()
        || root->view.scale!=m_view.scale || root->view.size.width()!=m_view.size.width() || root->view.size.height()!=m_view.size.height();
    const bool paletteChanged=!root->initialized || root->palette!=palette;
    const int visibleMask=int(m_visible[0]) | (int(m_visible[1])<<1) | (int(m_visible[2])<<2);
    const bool drawingChanged=viewChanged || paletteChanged || root->revision!=m_doc.revision()
        || root->visibleMask!=visibleMask || root->selection!=m_selected;
    if(viewChanged || paletteChanged){
        clearChildren(root->grid);
        QVector<QPointF> grid;
        double spacing=100;while(spacing*m_view.scale<28)spacing*=5;
        const auto low=m_view.world({0,height()}),high=m_view.world({width(),0});
        for(double x=std::ceil(low.x()/spacing)*spacing;x<=high.x();x+=spacing)segment(grid,m_view.screen({x,low.y()}),m_view.screen({x,high.y()}),0.5);
        for(double y=std::ceil(low.y()/spacing)*spacing;y<=high.y();y+=spacing)segment(grid,m_view.screen({low.x(),y}),m_view.screen({high.x(),y}),0.5);
        appendGeometry(root->grid,grid,color("grid"));
    }
    if(drawingChanged){
        // Zoom rebuilds screen-space strokes so widths and arc subdivision stay correct.
        // ponytail: view changes rebuild drawing batches; retain transformed geometry only if measured pan/zoom needs it.
        clearChildren(root->drawing);
        QVector<QPointF> layers[3],selection;
        for(auto &layer:layers)layer.reserve(m_doc.entities().size()*2);
        for(const auto &e:m_doc.entities())if(m_visible[e.layer]){
            if(e.kind!=Kind::Text)shape(e.id==m_selected?selection:layers[e.layer],e,m_view,e.id==m_selected?2.6:e.layer==0?1.8:1.0);
            else{
                const auto p=m_view.screen(e.a);const double height=e.textHeight*m_view.scale;
                if(height>=2&&p.x()+height*e.text.size()>0&&p.x()<width()&&p.y()+height>0&&p.y()-height*2<this->height()){
                    auto *text=window()->createTextNode();text->setColor(e.id==m_selected?color("focus"):color("ink"));
                    QFont font=QGuiApplication::font();font.setPixelSize(128);
                    QTextLayout layout(e.text,font);layout.beginLayout();auto line=layout.createLine();layout.endLayout();
                    text->addTextLayout(QPointF(0,-line.ascent()),&layout);
                    auto *transform=new QSGTransformNode;QMatrix4x4 matrix;matrix.translate(p.x(),p.y());matrix.scale(height/128,height/128);transform->setMatrix(matrix);
                    transform->appendChildNode(text);root->drawing->appendChildNode(transform);
                }
                if(e.id==m_selected){segment(selection,p-QPointF(6,0),p+QPointF(6,0),2);segment(selection,p-QPointF(0,6),p+QPointF(0,6),2);}
            }
        }
        for(int i=0;i<3;++i)appendGeometry(root->drawing,layers[i],color(i==0?"ink":i==1?"secondaryInk":"annotationInk"));
        appendGeometry(root->drawing,selection,color("focus"));
    }
    clearChildren(root->overlay);
    QVector<QPointF> ghost;
    if(!m_points.isEmpty()){
        Entity e;e.a=m_points.first();e.b=m_cursor;
        if(m_tool=="arc"&&m_points.size()==2){e.kind=Kind::Arc;e.radius=distance(e.a,m_points[1]);e.startDegrees=angle(e.a,m_points[1]);e.sweepDegrees=positiveDegrees(angle(e.a,m_cursor)-e.startDegrees);}
        shape(ghost,e,m_view,1.5);
    }
    if(m_tool!="pan"){
        const auto p=m_view.screen(m_cursor);segment(ghost,p-QPointF(9,0),p+QPointF(9,0),1);segment(ghost,p-QPointF(0,9),p+QPointF(0,9),1);
        if(m_snapped){segment(ghost,p+QPointF(-5,-5),p+QPointF(5,-5),2);segment(ghost,p+QPointF(5,-5),p+QPointF(5,5),2);segment(ghost,p+QPointF(5,5),p+QPointF(-5,5),2);segment(ghost,p+QPointF(-5,5),p+QPointF(-5,-5),2);}
    }
    appendGeometry(root->overlay,ghost,color(m_snapped?"snap":"focus"));
    root->view=m_view;root->palette=palette;root->revision=m_doc.revision();
    root->visibleMask=visibleMask;root->selection=m_selected;root->initialized=true;
    return root;
}
bool CadCanvas::exportPdf(QUrl url){
    const QString path=url.toLocalFile();
    if(!url.isLocalFile()||QFileInfo(path).suffix().toLower()!="pdf"){m_message="pdfPath";refresh();return false;}
    QLockFile lock(path+".lock");if(!lock.tryLock(0)){m_message="pdfFailed";refresh();return false;}
    if(QFileInfo::exists(path)){m_message="pdfExists";refresh();return false;}
    QSaveFile file(path);file.setDirectWriteFallback(false);if(!file.open(QIODevice::WriteOnly)){m_message="pdfFailed";refresh();return false;}
    {
        QPdfWriter writer(&file);writer.setResolution(254);writer.setPageSize(QPageSize(QPageSize::A3));writer.setPageOrientation(QPageLayout::Landscape);
        writer.setPageMargins(QMarginsF(10,10,10,10));writer.setCreator("Fresco CAD spike");
        // At 254 dpi, 10 pixels = 1 paper mm; 1:100 gives 0.1 pixels per model mm.
        QVector<const Entity *> visible;for(const auto &e:m_doc.entities())if(m_visible[e.layer])visible<<&e;
        const QPointF origin=visible.isEmpty()?QPointF():visible.first()->a;
        auto screen=[&](QPointF p){return QPointF((p.x()-origin.x())*0.1,-(p.y()-origin.y())*0.1);};
        auto entityPath=[&](const Entity &e){
            QPainterPath result;
            if(e.kind==Kind::Line){result.moveTo(screen(e.a));result.lineTo(screen(e.b));}
            else{
                const QPointF c=screen(e.a);const double r=e.radius*0.1;
                const QRectF ellipse(c-QPointF(r,r),QSizeF(2*r,2*r));
                const double start=positiveDegrees(e.startDegrees);
                // Qt emits cubic Bezier approximations; qreal avoids drawArc's 1/16 degree quantization.
                result.arcMoveTo(ellipse,start);result.arcTo(ellipse,start,e.sweepDegrees);
            }
            return result;
        };
        // A fixed font basis avoids allocating giant glyphs for hostile text heights;
        // the painter transform preserves fractional model sizes at exactly 1:100.
        QFont font=QGuiApplication::font();font.setPixelSize(100);
        const QFontMetricsF metrics(font,&writer);
        QRectF drawing;bool hasBounds=false;
        for(const Entity *e:visible){
            QRectF b;
            if(e->kind==Kind::Text){
                const double factor=e->textHeight*0.001;const auto ink=metrics.boundingRect(e->text);
                b=QRectF(ink.topLeft()*factor,ink.size()*factor).translated(screen(e->a));
                b.adjust(-1,-1,1,1);
            }else b=entityPath(*e).boundingRect().adjusted(-0.9,-0.9,0.9,0.9);
            drawing=hasBounds?drawing.united(b):b;hasBounds=true;
        }
        if(drawing.width()>writer.width()-2||drawing.height()>writer.height()-2){m_message="pdfBounds";refresh();return false;}
        QPainter painter(&writer);if(!painter.isActive()){m_message="pdfFailed";refresh();return false;}
        painter.translate(QPointF(writer.width()/2.0,writer.height()/2.0)-drawing.center());
        painter.setPen(QPen(Qt::black,1.8));
        painter.setFont(font);
        for(const Entity *e:visible){
            if(e->kind!=Kind::Text)painter.drawPath(entityPath(*e));
            else{
                const double factor=e->textHeight*0.001;
                painter.save();painter.translate(screen(e->a));painter.scale(factor,factor);
                painter.drawText(QPointF(),e->text);painter.restore();
            }
        }
        if(!painter.end()){m_message="pdfFailed";refresh();return false;}
    }
    // Cooperative exporters hold the lock; portable QSaveFile has no filesystem CAS
    // against an unrelated writer between this final check and its atomic rename.
    if(QFileInfo::exists(path)){m_message="pdfExists";refresh();return false;}
    if(file.error()!=QFileDevice::NoError){m_message="pdfFailed";refresh();return false;}
    const bool ok=file.commit();m_message=ok?"pdfSaved":"pdfFailed";refresh();return ok;
}
