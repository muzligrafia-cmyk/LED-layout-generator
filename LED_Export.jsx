/**********************************************************************
 * LED Layout Generator - STEP 1: EXPORT  (LED_Export.jsx)
 * ---------------------------------------------------------------
 * 1. Select exactly one closed path or compound path.
 * 2. Run this script, fill in the settings, click Calculate.
 * 3. The black calculation window (LED_Run.bat) opens by itself.
 *    Illustrator is free again immediately - nothing waits or freezes.
 * 4. When the black window says DONE, run LED_Import.jsx.
 *
 * This script never changes your document. It only writes the shape
 * outline + your settings into LED_layout_input.json on your Desktop.
 * Keep LED_Export.jsx, LED_Import.jsx, LED_Run.bat and led_engine.cjs
 * together (e.g. in Illustrator's Scripts folder).
 **********************************************************************/
#target illustrator

(function () {
    var TITLE = "LED Layout Generator";
    var FOLDER = File($.fileName).parent;
    // temporary JSON files go to the Desktop (Scripts folder is usually write-protected)
    var IN_FILE = new File(Folder.desktop + "/LED_layout_input.json");
    var OUT_FILE = new File(Folder.desktop + "/LED_layout_output.json");
    var BAT_FILE = new File(FOLDER + "/LED_Run.bat");

    var FACTORY = {
        diameterMm: 5, edgeMm: 5, centerMm: 30, wobbleMm: 10, seed: 12345,
        useCount: false, count: 20, startCorner: "auto", endCorner: "auto",
        variants: 4, avoidCrossings: true
    };

    // ---------------- tiny JSON helpers (ExtendScript has no JSON) ----
    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(Math.round(v * 10000) / 10000) : "0";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") {
            return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
        }
        if (v instanceof Array) {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(toJSON(v[i]));
            return "[" + a.join(",") + "]";
        }
        var parts = [];
        for (var k in v) if (v.hasOwnProperty(k)) parts.push('"' + k + '":' + toJSON(v[k]));
        return "{" + parts.join(",") + "}";
    }
    function readJSON(f) {
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var s = f.read(); f.close();
        try { return eval("(" + s + ")"); } catch (e) { return null; }
    }

    // ---------------- selection check ----------------
    function validateSelection(doc) {
        var sel = doc.selection;
        if (!sel || sel.length === 0) return { ok: false, msg: "Nothing is selected.\n\nSelect exactly one closed path or compound path, then run the script again." };
        if (sel.length > 1) return { ok: false, msg: "More than one object is selected (" + sel.length + ").\n\nSelect exactly one closed path or compound path." };
        var item = sel[0];
        if (item.typename === "PathItem") {
            if (!item.closed) return { ok: false, msg: "The selected path is not closed." };
            if (item.pathPoints.length < 3) return { ok: false, msg: "The selected path has fewer than 3 anchor points." };
            return { ok: true, item: item };
        }
        if (item.typename === "CompoundPathItem") {
            if (item.pathItems.length === 0) return { ok: false, msg: "The selected compound path contains no sub-paths." };
            for (var i = 0; i < item.pathItems.length; i++) {
                if (!item.pathItems[i].closed) return { ok: false, msg: "Sub-path " + (i + 1) + " of the compound path is not closed." };
            }
            return { ok: true, item: item };
        }
        return { ok: false, msg: "The selected object is a " + item.typename + ".\n\nSelect a closed path or a compound path (not a group, text, image, etc.)." };
    }

    // ---------------- dialog ----------------
    function showDialog(d) {
        var dlg = new Window("dialog", TITLE + " - Export");
        dlg.orientation = "column"; dlg.alignChildren = "fill"; dlg.margins = 16; dlg.spacing = 10;
        dlg.add("statictext", undefined, "All dimensions in millimetres (mm), whatever your ruler units are.", { multiline: true });

        function row(label, value, suffix) {
            var g = dlg.add("group");
            var st = g.add("statictext", undefined, label); st.preferredSize.width = 175;
            var et = g.add("edittext", undefined, String(value)); et.characters = 8;
            if (suffix) g.add("statictext", undefined, suffix);
            return et;
        }
        var etDia = row("LED / Circle Diameter:", d.diameterMm, "mm");
        var etEdge = row("Edge Clearance:", d.edgeMm, "mm");
        var etCenter = row("LED Center Distance:", d.centerMm, "mm  (0 = unlimited cable)");
        var etWobble = row("Organic Wobble:", d.wobbleMm, "mm");
        var etSeed = row("Random Seed:", d.seed, "");

        var gC = dlg.add("group");
        var cbCount = gC.add("checkbox", undefined, "Set exact LED count:"); cbCount.preferredSize.width = 175;
        cbCount.value = d.useCount === true;
        var etCount = gC.add("edittext", undefined, String(d.count)); etCount.characters = 8;
        etCount.enabled = cbCount.value;
        cbCount.onClick = function () { etCount.enabled = cbCount.value; };
        dlg.add("statictext", undefined, "Unchecked = fill automatically (needs a center distance above 0).");

        var LABELS = ["Auto", "Top left", "Top right", "Bottom left", "Bottom right"];
        var CODES = ["auto", "TL", "TR", "BL", "BR"];
        function cIdx(c) { for (var i = 0; i < CODES.length; i++) if (CODES[i] === c) return i; return 0; }
        function cornerRow(label, code) {
            var g = dlg.add("group");
            var st = g.add("statictext", undefined, label); st.preferredSize.width = 175;
            var dd = g.add("dropdownlist", undefined, LABELS); dd.selection = cIdx(code); dd.preferredSize.width = 120;
            return dd;
        }
        var ddStart = cornerRow("Cable Start Corner:", d.startCorner);
        var ddEnd = cornerRow("Cable End Corner:", d.endCorner);

        dlg.add("panel").preferredSize.height = 2;
        var cbCross = dlg.add("checkbox", undefined, "Avoid cable crossings");
        cbCross.value = d.avoidCrossings !== false;
        var etVar = row("Variants to generate:", d.variants, "(1-8, seeds count up)");

        var btns = dlg.add("group"); btns.alignment = "right";
        var bCancel = btns.add("button", undefined, "Cancel", { name: "cancel" });
        var bGo = btns.add("button", undefined, "Calculate", { name: "ok" });
        dlg.defaultElement = bGo; dlg.cancelElement = bCancel;

        var result = null;
        function num(et, label) {
            var v = parseFloat(et.text.replace(/,/g, "."));
            if (isNaN(v) || !isFinite(v)) throw new Error(label + " is not a valid number: \"" + et.text + "\"");
            return v;
        }
        bGo.onClick = function () {
            try {
                var p = {
                    diameterMm: num(etDia, "LED / Circle Diameter"),
                    edgeMm: num(etEdge, "Edge Clearance"),
                    centerMm: num(etCenter, "LED Center Distance"),
                    wobbleMm: num(etWobble, "Organic Wobble"),
                    seed: num(etSeed, "Random Seed"),
                    useCount: cbCount.value === true,
                    count: 0,
                    startCorner: CODES[ddStart.selection.index],
                    endCorner: CODES[ddEnd.selection.index],
                    variants: num(etVar, "Variants"),
                    avoidCrossings: cbCross.value === true
                };
                if (p.diameterMm <= 0) throw new Error("Diameter must be greater than 0.");
                if (p.edgeMm < 0) throw new Error("Edge clearance must be 0 or greater.");
                if (p.centerMm < 0) throw new Error("LED center distance can't be negative (use 0 for unlimited cable).");
                if (p.centerMm > 0 && p.centerMm <= p.diameterMm) throw new Error("LED center distance (" + p.centerMm + " mm) must be greater than the circle diameter (" + p.diameterMm + " mm), or 0 for unlimited cable.");
                if (p.centerMm === 0 && !cbCount.value) throw new Error("LED center distance 0 means unlimited cable, so there's no spacing to aim for.\n\nTick \"Set exact LED count\" and enter how many LEDs you want.");
                if (p.wobbleMm < 0) throw new Error("Wobble must be 0 or greater.");
                if (Math.floor(p.seed) !== p.seed) throw new Error("Random seed must be a whole number.");
                if (Math.floor(p.variants) !== p.variants || p.variants < 1 || p.variants > 8) throw new Error("Variants must be a whole number from 1 to 8.");
                if (p.useCount) {
                    p.count = num(etCount, "LED count");
                    if (Math.floor(p.count) !== p.count || p.count < 1) throw new Error("LED count must be a whole number of 1 or more.");
                } else {
                    p.count = d.count; // remember the typed value for next time
                }
                if (p.startCorner !== "auto" && p.startCorner === p.endCorner) throw new Error("Cable start and end corner are the same.\n\nChoose two different corners (or set one to Auto).");
                result = p;
                dlg.close(1);
            } catch (e) {
                alert("Invalid input:\n\n" + e.message, TITLE);
            }
        };
        bCancel.onClick = function () { dlg.close(2); };
        dlg.show();
        return result;
    }

    // ---------------- shape -> raw Bezier data ----------------
    function pathData(pathItem) {
        var pts = pathItem.pathPoints, out = [];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            out.push({
                a: [p.anchor[0], p.anchor[1]],
                l: [p.leftDirection[0], p.leftDirection[1]],
                r: [p.rightDirection[0], p.rightDirection[1]]
            });
        }
        return out;
    }

    // ---------------- main ----------------
    if (app.documents.length === 0) { alert("No document is open.", TITLE); return; }
    var doc = app.activeDocument;
    var sel = validateSelection(doc);
    if (!sel.ok) { alert(sel.msg, TITLE); return; }

    // defaults = last run's settings (read from the previous export), else factory
    var defaults = FACTORY;
    var prev = readJSON(IN_FILE);
    if (prev && prev.params) {
        defaults = {};
        for (var k in FACTORY) defaults[k] = (prev.params[k] !== undefined) ? prev.params[k] : FACTORY[k];
    }

    var params = showDialog(defaults);
    if (!params) return; // cancelled - nothing written

    var item = sel.item, paths = [];
    if (item.typename === "PathItem") paths.push(pathData(item));
    else for (var i = 0; i < item.pathItems.length; i++) paths.push(pathData(item.pathItems[i]));

    var job = {
        jobId: String(new Date().getTime()),
        docName: doc.name,
        params: params,
        paths: paths
    };

    // remove any old result so Import can't pick up a stale one
    if (OUT_FILE.exists) OUT_FILE.remove();

    IN_FILE.encoding = "UTF-8";
    if (!IN_FILE.open("w")) { alert("Could not write to your Desktop:\n" + IN_FILE.fsName, TITLE); return; }
    IN_FILE.write(toJSON(job));
    IN_FILE.close();

    if (!BAT_FILE.exists) {
        alert("Shape exported, but LED_Run.bat was not found next to this script:\n" + FOLDER.fsName +
            "\n\nPut all LED_ files in the same folder, then double-click LED_Run.bat yourself.", TITLE);
        return;
    }
    BAT_FILE.execute(); // opens the black window; Illustrator does NOT wait for it

    alert("Shape exported - the calculation is running in the black window.\n\n" +
        "When it says DONE, run LED_Import.jsx.", TITLE);
})();
