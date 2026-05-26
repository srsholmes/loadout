import pkg from "./package.json" with { type: "json" };

export default {
  app: {
    name: "loadout",
    identifier: "com.loadout.overlay",
    version: pkg.version,
    description: "Loadout overlay",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "webview-dist": "views/overlay",
    },
    targets: "linux-x64,linux-arm64",
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: {
        "remote-debugging-port": "9222",
        "remote-allow-origins": "*",
        "enable-logging": "stderr",
        "log-severity": "info",
        "touch-events": "enabled",
        "disable-features": "FieldTrialConfig,Variations,GlicActorUi,LensOverlay",
        "disable-field-trial-config": "",
        "disable-component-update": "",
      },
    },
  },
};
