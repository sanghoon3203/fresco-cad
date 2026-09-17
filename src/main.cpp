#include "canvas.h"
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QJsonDocument>
#include <QFile>
#include <QQuickWindow>
#include <QTimer>
#include <QElapsedTimer>
#include <QJsonObject>
#include <QJsonArray>
#include <QDir>
#include <QChronoTimer>
#include <QHoverEvent>
#include <QWheelEvent>
#include <QScreen>
#include <QSaveFile>
#include <QSGRendererInterface>
#include <atomic>
#include <memory>

static QJsonObject timingSummary(QVector<double> samples) {
    QJsonObject result{{"samples",samples.size()}};
    if(samples.isEmpty())return result;
    std::sort(samples.begin(),samples.end());
    double total=0;int over=0;for(double ms:samples){total+=ms;over+=ms>16.7;}
    result.insert("p50_ms",samples[(samples.size()-1)/2]);
    result.insert("p95_ms",samples[int(std::ceil(samples.size()*0.95))-1]);
    result.insert("max_ms",samples.last());result.insert("mean_ms",total/samples.size());
    result.insert("over_16_7_ms",over);return result;
}

static void benchmark(QGuiApplication &app,QQuickWindow *window,CadCanvas *canvas,const QString &output,const QString &mode) {
    window->resize(1320, 800); // Below this Mac screen's usable height; avoid window-manager clipping.
    // One fixed workload, not a benchmark framework. Render timestamps never depend on GUI delivery time.
    struct Measurements {
        QElapsedTimer clock;
        std::atomic<int> sequence{0};std::atomic<qint64> inputNs{0};
        // The following fields are used only on the scene-graph thread.
        int syncSequence=0; qint64 syncInputNs=0,syncNs=0,lastSwapNs=0;
        double cpuMs=0,swapMs=0;std::atomic<int> graphicsApi{0};
        // The remaining fields are used only on the GUI thread.
        QVector<qint64> dispatchNs;
        QVector<double> intervals,cpu,latestLatency,oldestLatency,handlers,feedIntervals;
        QJsonArray frames,inputs;int lastSubmitted=30,submitted=0;bool done=false;
        QSize initialWindow;QSizeF initialCanvas;QPointF initialCenter;double initialScale=0;
    };
    auto m=std::make_shared<Measurements>();m->clock.start();
    auto *feed=new QChronoTimer(std::chrono::nanoseconds(16666667),&app);
    feed->setTimerType(Qt::PreciseTimer);
    auto finish=[m,feed,window,canvas,output,mode,&app](bool complete) {
        if(m->done)return;m->done=true;feed->stop();
        const int dispatched=std::max(0,int(m->dispatchNs.size())-30);
        const double duration=dispatched>1?(m->dispatchNs.last()-m->dispatchNs[30])/1e6:0;
        const double dpr=window->devicePixelRatio();
        const QStringList apis{"Unknown","Software","OpenVG","OpenGL","Direct3D11","Vulkan","Metal","Null","Direct3D12"};
        QJsonObject result{{"harness_version",4},{"complete",complete},{"scene","100000 mixed line/arc/text; synthetic"},
            {"mode",mode},{"qt",qVersion()},{"entities",canvas->count()},
            {"graphics_api",apis.value(m->graphicsApi.load(),"Unknown")},{"graphics_api_id",m->graphicsApi.load()},
            {"window_logical_px",QJsonArray{window->width(),window->height()}},{"device_pixel_ratio",dpr},
            {"window_physical_px",QJsonArray{qRound(window->width()*dpr),qRound(window->height()*dpr)}},
            {"canvas_logical_px",QJsonArray{canvas->width(),canvas->height()}},{"initial_view_scale",m->initialScale},
            {"initial_view_center_mm",QJsonArray{m->initialCenter.x(),m->initialCenter.y()}},
            {"layout_unchanged",m->initialWindow==window->size()&&m->initialCanvas==QSizeF(canvas->width(),canvas->height())},
            {"screen_refresh_hz",window->screen()?window->screen()->refreshRate():0},
            {"target_feed_hz",60},{"warmup_dispatches",30},{"requested_measured_dispatches",150},
            {"dispatched_updates",dispatched},{"submitted_updates",m->submitted},
            {"coalesced_updates",std::max(0,m->lastSubmitted-30-m->submitted)},
            {"unsubmitted_updates",std::max(0,dispatched-(m->lastSubmitted-30))},
            {"submitted_dispatch_ratio",dispatched?double(m->submitted)/dispatched:0},
            {"feed_duration_ms",duration},{"feed_actual_hz",duration>0?(dispatched-1)*1000/duration:0},
            {"feed_interval",timingSummary(m->feedIntervals)},{"handler",timingSummary(m->handlers)},
            {"frame_interval",timingSummary(m->intervals)},{"cpu_sync_to_after_rendering",timingSummary(m->cpu)},
            {"latest_input_to_submitted",timingSummary(m->latestLatency)},{"oldest_pending_input_to_submitted",timingSummary(m->oldestLatency)},
            {"frame_time_target_ms",16.7},{"physical_pointer_to_preview","not measured"},
            {"timing_scope","CPU sync/command recording and synthetic dispatch-to-submission; no GPU completion or physical presentation timing"},
            {"feed_policy","Independent precise 60 Hz timer; delayed timers are not replayed; raw dispatch times expose delivery rate"},
            {"workload",mode=="zoom"?"60-step triangle: 30 x1.002 zoom steps then 30 inverse steps about canvas center":mode=="pan"?"60-step triangle: 30 +4px then 30 -4px horizontal scroll events":"Hover positions sweep 240 logical pixels at +/-40 logical pixels about canvas center"},
            {"raw_dispatches",m->inputs},{"raw_frames",m->frames}};
        QSaveFile file(output);const auto data=QJsonDocument(result).toJson();
        if(!file.open(QIODevice::WriteOnly)||file.write(data)!=data.size()||!file.commit()){
            qWarning("Could not save benchmark JSON");app.exit(2);return;
        }
        app.exit(complete?0:3);
    };
    QObject::connect(window,&QQuickWindow::beforeSynchronizing,&app,[m,window] {
        m->syncNs=m->clock.nsecsElapsed();m->syncSequence=m->sequence.load();m->syncInputNs=m->inputNs.load();
        m->swapMs=0;m->graphicsApi=int(window->rendererInterface()->graphicsApi());
    },Qt::DirectConnection);
    QObject::connect(window,&QQuickWindow::afterRendering,&app,[m] {m->cpuMs=(m->clock.nsecsElapsed()-m->syncNs)/1e6;},Qt::DirectConnection);
    QObject::connect(window,&QQuickWindow::frameSwapped,&app,[m] {
        const auto now=m->clock.nsecsElapsed();m->swapMs=m->lastSwapNs?(now-m->lastSwapNs)/1e6:0;m->lastSwapNs=now;
    },Qt::DirectConnection);
    QObject::connect(window,&QQuickWindow::afterFrameEnd,&app,[m,finish,&app] {
        const int seq=m->syncSequence;const auto now=m->clock.nsecsElapsed();
        const double latest=(now-m->syncInputNs)/1e6,cpu=m->cpuMs,interval=m->swapMs;
        QMetaObject::invokeMethod(&app,[m,finish,seq,now,latest,cpu,interval] {
            if(m->done||seq<=30)return;
            const bool fresh=seq>m->lastSubmitted;
            double oldest=0;
            if(fresh){
                oldest=(now-m->dispatchNs[std::max(30,m->lastSubmitted)])/1e6;
                ++m->submitted;m->latestLatency<<latest;m->oldestLatency<<oldest;m->lastSubmitted=seq;
            }
            if(interval>0)m->intervals<<interval;m->cpu<<cpu;
            m->frames.append(QJsonObject{{"sequence",seq},{"submitted_at_ms",now/1e6},{"new_input",fresh},
                {"frame_interval_ms",interval},{"cpu_ms",cpu},{"latest_input_ms",latest},{"oldest_pending_input_ms",oldest}});
            if(seq==180)finish(true);
        },Qt::QueuedConnection);
    },Qt::DirectConnection);
    QObject::connect(feed,&QChronoTimer::timeout,&app,[m,feed,canvas,mode] {
        const int seq=int(m->dispatchNs.size())+1;const auto now=m->clock.nsecsElapsed();m->dispatchNs<<now;
        const QPointF center(canvas->width()/2,canvas->height()/2);
        const int direction=(seq-1)%60<30?1:-1;QPointF position=center;
        if(mode=="zoom")canvas->zoomStep(direction>0?1.002:1/1.002);
        else if(mode=="pan"){
            QWheelEvent event(center,canvas->mapToGlobal(center),QPoint(direction*4,0),{},Qt::NoButton,Qt::NoModifier,Qt::ScrollUpdate,false);
            QCoreApplication::sendEvent(canvas,&event);
        }else{
            const QPointF p=center+QPointF((seq%60-30)*4,((seq/60)%2?1:-1)*40);
            position=p;
            QHoverEvent event(QEvent::HoverMove,p,canvas->mapToGlobal(p),center);
            QCoreApplication::sendEvent(canvas,&event);
        }
        const double handler=(m->clock.nsecsElapsed()-now)/1e6;
        m->inputNs.store(now);m->sequence.store(seq);
        if(seq>30){
            m->handlers<<handler;if(seq>31)m->feedIntervals<<(now-m->dispatchNs[seq-2])/1e6;
            const auto &view=canvas->view();
            m->inputs.append(QJsonObject{{"sequence",seq},{"dispatched_at_ms",now/1e6},{"handler_ms",handler},
                {"view_scale",view.scale},{"view_center_mm",QJsonArray{view.center.x(),view.center.y()}},
                {"pointer_logical_px",QJsonArray{position.x(),position.y()}}});
        }
        if(seq==180)feed->stop();
    });
    // QML's deferred sample and window constraints must settle before fitting the 100k scene.
    QTimer::singleShot(500,&app,[m,feed,window,canvas] {
        canvas->benchmarkScene(100000);
        m->initialWindow=window->size();m->initialCanvas={canvas->width(),canvas->height()};m->initialScale=canvas->view().scale;m->initialCenter=canvas->view().center;
        QTimer::singleShot(250,feed,&QChronoTimer::start);
    });
    QTimer::singleShot(60000,&app,[finish] {finish(false);});
}

static QVariantMap jsonResource(const QString &path) {
    QFile f(path); if(!f.open(QIODevice::ReadOnly)) qFatal("Missing resource");
    return QJsonDocument::fromJson(f.readAll()).object().toVariantMap();
}
int main(int argc,char **argv) {
    QGuiApplication app(argc,argv);
    app.setApplicationName("Fresco CAD"); app.setOrganizationName("Fresco Internal");
    QQuickStyle::setStyle("Basic");
    qmlRegisterType<CadCanvas>("Fresco",1,0,"CadCanvas");
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("theme",jsonResource(":/qml/theme.json"));
    engine.rootContext()->setContextProperty("catalog",jsonResource(":/qml/strings.json"));
    engine.load(QUrl("qrc:/qml/Main.qml"));
    if(engine.rootObjects().isEmpty()) return 1;
    auto *window=qobject_cast<QQuickWindow*>(engine.rootObjects().first());
    auto *canvas=window->findChild<CadCanvas*>("cadCanvas");
    const auto args=app.arguments();
    const int languageIndex=args.indexOf("--language");
    if(languageIndex>=0 && languageIndex+1<args.size() && QStringList{"ja-JP","ko-KR","en-US"}.contains(args[languageIndex+1]))
        window->setProperty("language",args[languageIndex+1]);
    if(args.contains("--compact")) {window->resize(1000,700);QTimer::singleShot(100,canvas,&CadCanvas::fit);}
    if(args.contains("--selected")) QTimer::singleShot(500,canvas,&CadCanvas::selectNext);
    const int captureIndex=args.indexOf("--capture");
    if(captureIndex>=0 && captureIndex+1<args.size()) {
        const QString output=args.at(captureIndex+1);
        QTimer::singleShot(1800,&app,[window,output,&app] { app.exit(window->grabWindow().save(output)?0:2); });
    }
    const int benchmarkIndex=args.indexOf("--benchmark");
    if(benchmarkIndex>=0) {
        const int modeIndex=args.indexOf("--benchmark-mode");
        const QString mode=modeIndex<0?"zoom":args.value(modeIndex+1);
        if(benchmarkIndex+1>=args.size()||args[benchmarkIndex+1].startsWith("--")||!QStringList{"zoom","pan","hover"}.contains(mode)||args.contains("--capture")){
            qWarning("Usage: --benchmark OUTPUT.json [--benchmark-mode zoom|pan|hover], without --capture");return 2;
        }
        const QString output=args.at(benchmarkIndex+1);
        benchmark(app,window,canvas,output,mode);
    }
    return app.exec();
}
