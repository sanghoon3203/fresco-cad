#pragma once
#include "document.h"
#include <QLineF>
#include <QSizeF>
#include <algorithm>
#include <cmath>
#include <numbers>

namespace cad {
inline constexpr double pi = std::numbers::pi;
inline double distance(QPointF a, QPointF b) { return std::hypot(a.x()-b.x(),a.y()-b.y()); }
inline double angle(QPointF center,QPointF p) { return std::atan2(p.y()-center.y(),p.x()-center.x())*180/pi; }
inline double positiveDegrees(double a) { return std::fmod(std::fmod(a,360.0)+360.0,360.0); }
inline QPointF arcPoint(const Entity &e,double degrees) { const double radians=positiveDegrees(degrees)*pi/180; return e.a+QPointF(std::cos(radians),std::sin(radians))*e.radius; }
inline double segmentDistance(QPointF p,QPointF a,QPointF b) {
    const auto d=b-a; const double length2=QPointF::dotProduct(d,d);
    const double t=length2>0 ? std::clamp(QPointF::dotProduct(p-a,d)/length2,0.0,1.0) : 0;
    return distance(p,a+d*t);
}
inline double entityDistance(QPointF p,const Entity &e) {
    if(e.kind==Kind::Line) return segmentDistance(p,e.a,e.b);
    if(e.kind==Kind::Text) return distance(p,e.a); // Text selection is its visible insertion cross.
    const double a=angle(e.a,p);
    const double start=positiveDegrees(e.startDegrees);
    const double travel=e.sweepDegrees>=0 ? positiveDegrees(a-start) : positiveDegrees(start-a);
    if(travel<=std::abs(e.sweepDegrees)) return std::abs(distance(p,e.a)-e.radius);
    return std::min(distance(p,arcPoint(e,start)),distance(p,arcPoint(e,start+e.sweepDegrees)));
}
struct View {
    QPointF center{5000,3500}; double scale=0.075; QSizeF size{1000,700};
    QPointF screen(QPointF p) const { return {size.width()/2+(p.x()-center.x())*scale,size.height()/2-(p.y()-center.y())*scale}; }
    QPointF world(QPointF p) const { return {center.x()+(p.x()-size.width()/2)/scale,center.y()-(p.y()-size.height()/2)/scale}; }
    void zoom(QPointF anchor,double factor) {
        const auto before=world(anchor); scale=std::clamp(scale*factor,0.00001,20.0); center+=before-world(anchor);
    }
};
}
