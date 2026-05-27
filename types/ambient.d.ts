// Ambient module declarations for third-party packages we don't ship types for.
//
// `electrobun` transitively imports `three` for its (unused-by-us) 3D view.
// We don't render anything with three.js, and installing @types/three would
// pull ~MBs of declarations just to silence one TS7016. This stub lets the
// electrobun source compile under strict mode.
declare module "three";
