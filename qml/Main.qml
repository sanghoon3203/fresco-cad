import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import Fresco 1.0

ApplicationWindow {
    id: root
    width: 1320; height: 900; minimumWidth: 1000; minimumHeight: 700
    visible: true
    color: theme.colors.background
    title: t("title")
    font.pixelSize: theme.type.body
    palette.text: theme.colors.ink
    palette.windowText: theme.colors.ink
    palette.buttonText: theme.colors.ink
    palette.highlight: theme.colors.focus
    palette.highlightedText: theme.colors.onPrimary
    property string language: "ja-JP"
    property bool allowClose: false
    property string pendingAction: ""
    function t(key) { return catalog[language][key] === undefined ? key : catalog[language][key] }
    function requestOpen() { if (cad.dirty) {pendingAction="open"; discardDialog.open()} else openDialog.open() }
    function saveDrawing() { if (cad.fileUrl.toString().length) cad.save(cad.fileUrl); else saveDialog.open() }
    onClosing: function(close) { if (cad.dirty && !allowClose) { close.accepted=false; pendingAction="close"; discardDialog.open() } }
    Shortcut { sequence: StandardKey.Save; onActivated: root.saveDrawing() }
    Shortcut { sequence: StandardKey.Open; onActivated: root.requestOpen() }
    Shortcut { sequence: StandardKey.Undo; enabled: cad.activeFocus; onActivated: cad.undo() }
    Shortcut { sequence: StandardKey.Redo; enabled: cad.activeFocus; onActivated: cad.redo() }

    ColumnLayout {
        anchors.fill: parent; spacing: 1
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: theme.size.header; color: theme.colors.surface
            RowLayout {
                anchors.fill: parent; anchors.leftMargin: theme.space.xl; anchors.rightMargin: theme.space.lg; spacing: theme.space.md
                Rectangle { width: 34; height: 34; radius: theme.radius.control; color: theme.colors.brandSurface
                    Text { anchors.centerIn: parent; text: "F"; font.pixelSize: theme.type.title; font.bold: true; color: theme.colors.ink }
                }
                Label { text: "Fresco CAD"; font.pixelSize: theme.type.brand; font.bold: true; color: theme.colors.ink }
                Rectangle { implicitWidth: badge.implicitWidth+theme.space.lg; implicitHeight: 24; radius: 4; color: theme.colors.background
                    Label { id: badge; anchors.centerIn: parent; text: root.t("preview"); font.pixelSize: theme.type.small; color: theme.colors.muted }
                }
                Item { Layout.fillWidth: true }
                CadButton { text: root.t("open"); onClicked: root.requestOpen() }
                CadButton { text: root.t("save"); primary: true; onClicked: root.saveDrawing() }
                CadButton { text: root.t("export"); onClicked: pdfDialog.open() }
                ComboBox {
                    id: languagePicker; objectName: "languagePicker"; model: ["日本語", "한국어", "English"]; implicitWidth: 115
                    Accessible.name: root.t("language")
                    currentIndex: ["ja-JP","ko-KR","en-US"].indexOf(root.language)
                    onActivated: root.language=["ja-JP","ko-KR","en-US"][currentIndex]
                }
                CadButton { text: "?"; Accessible.name: root.t("help"); implicitWidth: 36; onClicked: guide.open() }
            }
        }
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: theme.size.toolbar; color: theme.colors.surface
            RowLayout {
                anchors.fill: parent; anchors.leftMargin: theme.space.lg; anchors.rightMargin: theme.space.lg; spacing: theme.space.sm
                Repeater { model: ["select","line","arc","text","pan"]
                    CadButton { required property string modelData; text: root.t(modelData); checked: cad.tool===modelData; onClicked: {cad.tool=modelData;cad.forceActiveFocus()} }
                }
                Rectangle { width: 1; Layout.preferredHeight: 24; color: theme.colors.border }
                CadButton { text: root.t("undo"); enabled: cad.undoAvailable; onClicked: cad.undo() }
                CadButton { text: root.t("redo"); enabled: cad.redoAvailable; onClicked: cad.redo() }
                Item { Layout.fillWidth: true }
                CadButton { text: "−"; Accessible.name: root.t("zoomOut"); implicitWidth: 36; onClicked: cad.zoomStep(1/1.2) }
                CadButton { text: "+"; Accessible.name: root.t("zoomIn"); implicitWidth: 36; onClicked: cad.zoomStep(1.2) }
                CadButton { text: root.t("fit"); onClicked: cad.fit() }
            }
        }
        RowLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 1
            Rectangle {
                Layout.preferredWidth: theme.size.sidebar; Layout.fillHeight: true; color: theme.colors.surface
                ScrollView {
                    anchors.fill: parent; contentWidth: availableWidth; clip: true
                    ColumnLayout {
                        width: parent.width; spacing: theme.space.lg
                        ColumnLayout {
                            Layout.fillWidth: true; Layout.margins: theme.space.lg; spacing: theme.space.sm
                            Label { text: root.t("drawing"); color: theme.colors.muted; font.pixelSize: theme.type.label; font.bold: true }
                            Label { text: cad.fileName.length ? root.t("drawing") : root.t("sample"); color: theme.colors.ink; font.bold: true; Layout.fillWidth: true; wrapMode: Text.Wrap }
                            Label { text: cad.fileName.length ? cad.fileName : root.t("untitled"); Layout.fillWidth: true; elide: Text.ElideMiddle; color: theme.colors.muted; font.pixelSize: theme.type.small }
                            Label { text: cad.dirty ? root.t("dirty") : root.t("clean"); color: theme.colors.focus; font.pixelSize: theme.type.small }
                            RowLayout { Label { text: root.t("entityCount"); color: theme.colors.muted } Item { Layout.fillWidth: true } Label { text: cad.count; color: theme.colors.ink; font.bold: true } }
                            Rectangle { Layout.fillWidth: true; height: 1; color: theme.colors.border }
                            Label { text: root.t("layers"); color: theme.colors.muted; font.pixelSize: theme.type.label; font.bold: true }
                            Repeater { model: ["layer0","layer1","layer2"]
                                CheckBox { required property string modelData; required property int index; text: root.t(modelData); checked: true; Layout.fillWidth: true; onToggled: cad.setLayerVisible(index,checked) }
                            }
                            Label { text: root.t("activeLayer"); color: theme.colors.muted; font.pixelSize: theme.type.small }
                            ComboBox { Layout.fillWidth: true; model: [root.t("layer0"),root.t("layer1"),root.t("layer2")]; Accessible.name: root.t("activeLayer"); onActivated: cad.activeLayer=currentIndex }
                            Rectangle { Layout.fillWidth: true; height: 1; color: theme.colors.border; Layout.topMargin: theme.space.sm }
                            Label { text: root.t("precision"); color: theme.colors.muted; font.pixelSize: theme.type.label; font.bold: true }
                            RowLayout { Field { id: x1; objectName: "startX"; Layout.fillWidth: true; label: root.t("startX"); text: "0" } Field { id: y1; Layout.fillWidth: true; label: root.t("startY"); text: "0" } }
                            RowLayout { Field { id: x2; objectName: "endX"; Layout.fillWidth: true; label: root.t("endX"); text: "1000" } Field { id: y2; Layout.fillWidth: true; label: root.t("endY"); text: "0" } }
                            CadButton { Layout.fillWidth: true; text: root.t("addLine"); enabled: x1.valid && y1.valid && x2.valid && y2.valid; onClicked: cad.line(x1.numericValue,y1.numericValue,x2.numericValue,y2.numericValue) }
                            Field { id: textInput; objectName: "drawingText"; Layout.fillWidth: true; label: root.t("textContent"); text: root.t("textDefault"); numeric: false }
                            Rectangle { Layout.fillWidth: true; height: 1; color: theme.colors.border; Layout.topMargin: theme.space.sm }
                            Label { text: root.t("selection"); color: theme.colors.muted; font.pixelSize: theme.type.label; font.bold: true }
                            Label { text: cad.hasSelection ? cad.selectionInfo : root.t("noSelection"); color: theme.colors.muted; font.pixelSize: theme.type.small; Layout.fillWidth: true; wrapMode: Text.Wrap }
                            RowLayout { Field { id: dx; Layout.fillWidth: true; label: root.t("deltaX"); text: "100" } Field { id: dy; Layout.fillWidth: true; label: root.t("deltaY"); text: "0" } }
                            RowLayout { CadButton { text: root.t("move"); enabled: cad.hasSelection && dx.valid && dy.valid; onClicked: cad.moveSelected(dx.numericValue,dy.numericValue) } CadButton { text: root.t("delete"); enabled: cad.hasSelection; onClicked: cad.removeSelected() } }
                        }
                    }
                }
            }
            Rectangle {
                Layout.fillWidth: true; Layout.fillHeight: true; color: theme.colors.canvas
                CadCanvas { id: cad; objectName: "cadCanvas"; anchors.fill: parent; palette: theme.colors; textValue: textInput.text; focus: true; Accessible.role: Accessible.Canvas; Accessible.name: root.t("drawing"); Component.onCompleted: Qt.callLater(sample) }
                Rectangle {
                    anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right; anchors.margins: theme.space.lg; height: 42
                    radius: theme.radius.panel; color: theme.colors.surface; border.color: theme.colors.border
                    RowLayout { anchors.fill: parent; anchors.margins: theme.space.md
                        Label { text: root.t(cad.tool+"Hint"); color: theme.colors.muted; font.pixelSize: theme.type.label; Layout.fillWidth: true; elide: Text.ElideRight }
                        Label { text: root.t("step"); visible: cad.stage>0; color: theme.colors.focus; font.pixelSize: theme.type.small }
                        Label { text: cad.stage; visible: cad.stage>0; color: theme.colors.focus; font.bold: true }
                    }
                }
                Rectangle {
                    anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.margins: theme.space.lg; width: hud.implicitWidth+24; height: 40
                    color: theme.colors.surface; radius: theme.radius.panel; border.color: theme.colors.border
                    Label { id: hud; anchors.centerIn: parent; text: cad.coordinates; color: theme.colors.ink; font.family: "monospace"; font.pixelSize: theme.type.label }
                }
                Rectangle { anchors.right: parent.right; anchors.bottom: parent.bottom; anchors.margins: theme.space.lg; width: 52; height: 40; radius: theme.radius.panel; color: cad.activeFocus ? theme.colors.brandSurface : theme.colors.surface; border.color: theme.colors.focus
                    Label { anchors.centerIn: parent; text: "XY"; color: theme.colors.focus; font.bold: true }
                }
            }
        }
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: theme.size.status; color: theme.colors.surface
            RowLayout { anchors.fill: parent; anchors.leftMargin: theme.space.lg; anchors.rightMargin: theme.space.lg; spacing: theme.space.md
                Label { text: root.t(cad.message); color: theme.colors.muted; font.pixelSize: theme.type.small; Layout.fillWidth: true; elide: Text.ElideRight; ToolTip.visible: statusMouse.containsMouse; ToolTip.text: text; MouseArea { id: statusMouse; anchors.fill: parent; hoverEnabled: true } }
                CheckBox { text: root.t("snapGrid"); checked: true; onToggled: cad.gridSnap=checked; font.pixelSize: theme.type.small }
                CheckBox { text: root.t("snapObject"); checked: true; onToggled: cad.objectSnap=checked; font.pixelSize: theme.type.small }
                Label { text: root.t("unsupported"); color: theme.colors.muted; font.pixelSize: theme.type.small }
            }
        }
    }
    FileDialog { id: openDialog; title: root.t("open"); nameFilters: [root.t("frescoFilter")]; onAccepted: cad.load(selectedFile) }
    FileDialog { id: saveDialog; title: root.t("save"); fileMode: FileDialog.SaveFile; defaultSuffix: "fresco"; nameFilters: [root.t("frescoFilter")]; onAccepted: cad.save(selectedFile) }
    FileDialog { id: pdfDialog; title: root.t("pdfTitle"); fileMode: FileDialog.SaveFile; defaultSuffix: "pdf"; nameFilters: [root.t("pdfFilter")]; onAccepted: cad.exportPdf(selectedFile) }
    Dialog {
        id: discardDialog; anchors.centerIn: parent; modal: true; title: root.t("discardTitle"); width: 450
        contentItem: Label { text: root.t("discardBody"); wrapMode: Text.Wrap; color: theme.colors.ink }
        footer: RowLayout { spacing: theme.space.sm
            Item { Layout.fillWidth: true }
            CadButton { text: root.t("cancel"); onClicked: discardDialog.close() }
            CadButton { text: root.t("discard"); onClicked: {discardDialog.close(); if(root.pendingAction==="close"){root.allowClose=true; root.close()}else openDialog.open()} }
        }
    }
    Dialog {
        id: guide; anchors.centerIn: parent; modal: true; title: root.t("help"); width: 620
        contentItem: Label { text: root.t("guideBody"); wrapMode: Text.Wrap; color: theme.colors.ink; lineHeight: 1.4 }
        footer: CadButton { text: root.t("close"); onClicked: guide.close() }
    }
}
