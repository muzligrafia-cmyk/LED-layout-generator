# LED-layout-generator (3-step version)
An Adobe Illustrator script that generates custom holes for any material that needs LED lights inserted (or any other purpose.) Runs in three steps and outsources actual calculations to Node.js

=====================================

Put these 4 files together in Illustrator's Scripts folder:
  LED_Export.jsx, LED_Import.jsx, LED_Run.bat, led_engine.cjs

1. In Illustrator: select ONE closed path / compound path.
   File > Scripts > LED_Export  -> fill in settings -> Calculate.

2. A black window opens by itself and does the maths.
   (First run only: it installs clipper-lib into your user folder,
   needs internet once.) Wait until it says DONE.

3. Back in Illustrator: File > Scripts > LED_Import
   "All variants side by side" to compare, or "Only variant N"
   to place one exactly on your shape.

Temporary files (safe to delete any time) appear on your Desktop:
  LED_layout_input.json, LED_layout_output.json
