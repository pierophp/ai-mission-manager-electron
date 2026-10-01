module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: ["agents/pstack", "src/main/pstack-manifest.json"],
    ignore: [/ai-mission-manager-tauri/],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"],
    },
  ],
};
