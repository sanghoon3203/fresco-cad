import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    property string label: ""
    property alias text: input.text
    property bool numeric: true
    readonly property bool valid: input.acceptableInput && input.text.trim().length > 0
    readonly property real numericValue: numeric && valid ? Number.fromLocaleString(Qt.locale("en_US"), text) : NaN
    spacing: theme.space.xs
    Label { text: root.label; color: theme.colors.muted; font.pixelSize: theme.type.small }
    TextField {
        id: input
        objectName: root.objectName + "Input"
        Layout.fillWidth: true
        implicitHeight: theme.size.control
        selectByMouse: true
        maximumLength: root.numeric ? 32 : 4096
        Accessible.name: root.label
        font.pixelSize: theme.type.body
        color: theme.colors.ink
        validator: root.numeric ? numberValidator : null
        DoubleValidator { id: numberValidator; bottom: -1000000000; top: 1000000000; decimals: 9; locale: "en_US"; notation: DoubleValidator.StandardNotation }
        background: Rectangle { color: theme.colors.surface; radius: theme.radius.control; border.width: input.activeFocus ? 2 : 1; border.color: input.activeFocus ? theme.colors.focus : theme.colors.border }
    }
}
