# Affordability — demo

A clickable walkthrough of Click2Check's affordability layer, for showing to
prospective customers. It sits alongside the
[HMRC verification demo](https://click2checkdev.github.io/HMRC-demo/) and uses
the same styling.

**Live: https://click2checkdev.github.io/Affordability-demo/**

Fictional data, no backend: nothing is requested from any bureau.

This repository holds built output only. The source, and the affordability
engine that produced every figure, live in the private
`Click2CheckDev/Affordability` repository (`static_demo/`). Don't edit files
here; rebuild them there:

    python static_demo/build.py ../Affordability-demo
