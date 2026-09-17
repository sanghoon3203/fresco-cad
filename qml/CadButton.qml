import QtQuick
import QtQuick.Controls

Button {
    id: control
    property bool primary: false
    implicitHeight: theme.size.control
    implicitWidth: Math.max(72, contentItem.implicitWidth + theme.space.xl)
    padding: theme.space.sm
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    font.pixelSize: theme.type.body
    background: Rectangle {
        radius: theme.radius.control
        color: !control.enabled ? theme.colors.background : control.down ? theme.colors.pressed : control.primary ? theme.colors.primary : control.checked ? theme.colors.brandSurface : control.hovered ? theme.colors.hover : theme.colors.surface
        border.width: control.activeFocus ? 2 : 1
        border.color: control.activeFocus || control.checked ? theme.colors.focus : theme.colors.border
    }
    contentItem: Text {
        text: control.text
        font: control.font
        color: !control.enabled ? theme.colors.disabled : control.primary && !control.down ? theme.colors.onPrimary : theme.colors.ink
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
    }
}
