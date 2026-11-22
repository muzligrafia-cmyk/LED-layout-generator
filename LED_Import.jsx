/**********************************************************************
 * LED Layout Generator - STEP 3: IMPORT  (LED_Import.jsx)
 * ---------------------------------------------------------------
 * Run after the black calculation window says DONE.
 * Choose to preview all variants side by side, or place one variant
 * exactly on top of your original shape.
 * Everything is drawn on the active layer, grouped.
 **********************************************************************/
#target illustrator

var STEP = "starting";
var TITLE = "LED Layout Generator";

function main() {
    // temporary JSON files live on the Desktop
    var IN_FILE = new File(Folder.desktop + "/LED_layout_input.json");
    var OUT_FILE = new File(Folder.desktop + "/LED_layout_output.json");
    var MM = 72 / 25.4;
    var GAP_PT = 20 * MM; // space between side-by-side previews

    function readJSON(f) {
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var s = f.read(); f.close();
        if (s.charCodeAt(0) === 0xFEFF) s = s.substring(1);
        try { return eval("(" + s + ")"); } catch (e) { return null; }
    }

    // ---------------- checks ----------------
    if (app.documents.length === 0) { alert("No document is open.", TITLE); return; }
    var doc = app.activeDocument;

    STEP = "reading the result files from the Desktop";
    var inp = readJSON(IN_FILE);
    var out = readJSON(OUT_FILE);
    if (!out) {
        alert("No result yet.\n\nEither the calculation is still running (check the black window), " +
            "or it never started - run LED_Export.jsx first.", TITLE);
        return;
    }
    if (inp && out.jobId !== inp.jobId) {
        alert("The result file belongs to an older export.\n\nRun LED_Export.jsx again.", TITLE);
        return;
    }
    if (!out.ok) { alert(out.message || "The calculation failed.", TITLE); return; }
    if (out.docName !== doc.name) {
        if (!confirm("This layout was calculated for \"" + out.docName + "\",\nbut the active document is \"" + doc.name +
            "\".\n\nPlace it here anyway?", false, TITLE)) return;
    }
    var layer = doc.activeLayer;
    if (layer.locked || !layer.visible) { alert("The active layer \"" + layer.name + "\" is locked or hidden.\n\nUnlock/show it or pick another layer.", TITLE); return; }

    var P = out.params, V = out.variants;

    // ---------------- dialog ----------------
    function fmt(v, i) {
        return (i + 1) + ")  seed " + v.seed + "   |   " + v.ledCount + " LEDs   |   cable " + (v.cableMm / 1000).toFixed(2) +
            " m   |   longest " + v.maxSegMm + " mm   |   wobble " + v.wobbleMm + " mm" +
            (v.crossings ? "   |   " + v.crossings + " crossing(s)" : "") +
            (v.tipsLeftEmpty ? "   |   " + v.tipsLeftEmpty + " thin tip(s) left empty" : "");
    }
    STEP = "building the dialog";
    var dlg = new Window("dialog", TITLE + " - Import");
    dlg.orientation = "column"; dlg.alignChildren = "fill"; dlg.margins = 16; dlg.spacing = 8;
    dlg.add("statictext", undefined, V.length + " variant(s) ready (calculated in " + out.seconds + " s):");
    var pnl = dlg.add("panel"); pnl.alignChildren = "left"; pnl.margins = 12;
    for (var i = 0; i < V.length; i++) pnl.add("statictext", undefined, fmt(V[i], i));
    if (out.failedSeeds && out.failedSeeds.length) {
        dlg.add("statictext", undefined, "No valid layout for seed(s): " + out.failedSeeds.join(", ") + " (skipped).");
    }
    var choices = ["All variants side by side (preview)"];
    for (var c = 0; c < V.length; c++) choices.push("Only variant " + (c + 1) + " - exactly on my shape");
    var gp = dlg.add("group");
    gp.add("statictext", undefined, "Place:");
    var dd = gp.add("dropdownlist", undefined, choices);
    dd.selection = V.length > 1 ? 0 : 1;
    dd.preferredSize.width = 300;
    dlg.add("statictext", undefined, "Variant 1 always lands exactly on your shape; the others line up next to it.", { multiline: true });
    var btns = dlg.add("group"); btns.alignment = "right";
    var bCancel = btns.add("button", undefined, "Cancel", { name: "cancel" });
    var bOk = btns.add("button", undefined, "Place", { name: "ok" });
    dlg.defaultElement = bOk; dlg.cancelElement = bCancel;
    if (dlg.show() !== 1) return;
    var choice = dd.selection.index; // 0 = all, n = variant n

    // ---------------- drawing ----------------
    function color(r, g, b, cc, m, y, k) {
        if (doc.documentColorSpace === DocumentColorSpace.RGB) {
            var col = new RGBColor(); col.red = r; col.green = g; col.blue = b; return col;
        }
        var cm = new CMYKColor(); cm.cyan = cc; cm.magenta = m; cm.yellow = y; cm.black = k; return cm;
    }
    STEP = "preparing colours";
    var BLACK = color(0, 0, 0, 0, 0, 0, 100);
    var RED = color(255, 0, 0, 0, 100, 100, 0);
    var GREY = color(160, 160, 160, 0, 0, 0, 40);
    var dia = P.diameterMm * MM, rad = dia / 2;
    var B = out.boundsPt, shapeW = B.maxX - B.minX;

    var shapeH = B.maxY - B.minY;
    var LABEL_PT = 24; // room above each preview for its label

    function drawVariant(parent, v, dx, dy, withOutline, withLabel) {
        var g = parent.groupItems.add();
        g.name = "LED Layout (" + v.ledCount + " LEDs, seed " + v.seed + ")";
        if (withOutline) {
            STEP = "drawing the shape outline for variant " + v._n;
            for (var r = 0; r < out.outlinePt.length; r++) {
                var ring = out.outlinePt[r], cs = [];
                for (var q = 0; q < ring.length; q++) cs.push([ring[q][0] + dx, ring[q][1] + dy]);
                var ol = g.pathItems.add();
                ol.setEntirePath(cs); ol.closed = true; ol.filled = false;
                ol.stroked = true; ol.strokeColor = GREY; ol.strokeWidth = 0.5; ol.name = "Shape outline (preview)";
            }
        }
        if (v.points.length >= 2) {
            STEP = "drawing the cable for variant " + v._n;
            var coords = [];
            for (var k = 0; k < v.points.length; k++) coords.push([v.points[k][0] + dx, v.points[k][1] + dy]);
            var cable = g.pathItems.add();
            cable.setEntirePath(coords); cable.closed = false; cable.filled = false;
            cable.stroked = true; cable.strokeWidth = 1; cable.strokeColor = RED; cable.name = "Cable route";
        }
        STEP = "drawing the LED circles for variant " + v._n;
        // circles in cable order: LED 1 = cable start
        for (var j = 0; j < v.points.length; j++) {
            var p = v.points[j];
            var e = g.pathItems.ellipse(p[1] + dy + rad, p[0] + dx - rad, dia, dia);
            e.filled = false; e.stroked = true; e.strokeWidth = 0.5; e.strokeColor = BLACK;
            e.name = "LED " + (j + 1);
        }
        if (withLabel) {
            STEP = "writing the label for variant " + v._n;
            try {
                var t = g.textFrames.pointText([B.minX + dx, B.maxY + dy + 10]);
                t.contents = "Variant " + v._n + "  -  seed " + v.seed + "  -  " + v.ledCount +
                    " LEDs  -  cable " + (v.cableMm / 1000).toFixed(2) + " m";
                t.textRange.characterAttributes.size = 10;
                t.name = "Variant label";
            } catch (labelErr) { /* a missing label is not worth failing over */ }
        }
        return g;
    }

    for (var n = 0; n < V.length; n++) V[n]._n = n + 1;
    var placed;
    if (choice === 0) {
        // Grid instead of one long row: a long row runs off Illustrator's
        // canvas with big shapes ("Illegal argument"). Variant 1 stays
        // exactly on the shape; the rest fill the grid right and down.
        var cols = Math.ceil(Math.sqrt(V.length));
        var stepX = shapeW + GAP_PT, stepY = shapeH + GAP_PT + LABEL_PT;
        STEP = "creating the preview group";
        placed = layer.groupItems.add();
        placed.name = "LED Variants (preview)";
        try {
            for (var s = 0; s < V.length; s++) {
                var col = s % cols, row = Math.floor(s / cols);
                drawVariant(placed, V[s], col * stepX, -row * stepY, s > 0, true);
            }
        } catch (drawErr) {
            var where = STEP;
            try { placed.remove(); } catch (x) { }
            alert("The side-by-side preview doesn't fit on Illustrator's canvas (the shape is too big to line up " +
                V.length + " copies), or Illustrator refused a shape while " + where + ".\n\n" +
                "Nothing was left behind. Run LED_Import again and choose \"Only variant N\" - that always lands exactly on your shape.\n\n" +
                "(Details: " + drawErr.message + ", line " + drawErr.line + ")", TITLE);
            return;
        }
    } else {
        STEP = "creating the layout group";
        placed = drawVariant(layer, V[choice - 1], 0, 0, false, false);
    }
    STEP = "selecting the result";
    try { doc.selection = null; placed.selected = true; } catch (selErr) { }
    app.redraw();

    var cornerNames = { TL: "top left", TR: "top right", BL: "bottom left", BR: "bottom right" };
    var msg = (choice === 0) ? ("Placed " + V.length + " variants in a grid (variant 1 is on your shape).\n\nTo use one exactly on your shape, delete the preview and run LED_Import.jsx again, choosing \"Only variant N\".\n\n")
        : ("Placed variant " + choice + ": " + V[choice - 1].ledCount + " LEDs.\n\n");
    if (P.startCorner !== "auto") msg += "Cable starts at the LED nearest the " + cornerNames[P.startCorner] + " corner (\"LED 1\").\n";
    if (P.endCorner !== "auto") msg += "Cable ends at the LED nearest the " + cornerNames[P.endCorner] + " corner.\n";
    alert(msg, TITLE);
}

try {
    main();
} catch (err) {
    alert("Import stopped while " + STEP + ".\n\n" + err.message + "  (line " + err.line + ")\n\n" +
        "A screenshot of this message will pinpoint the problem.", TITLE);
}
