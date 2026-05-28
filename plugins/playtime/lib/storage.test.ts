import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { pluginDataPath, readPluginData, writePluginData } from "./storage";

describe("storage", () => {
  let mkdirSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let renameSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined as unknown as string);
    readFileSpy = spyOn(fsPromises, "readFile").mockRejectedValue(new Error("ENOENT"));
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    renameSpy = spyOn(fsPromises, "rename").mockResolvedValue(undefined);
  });

  afterEach(() => {
    mkdirSpy.mockRestore();
    readFileSpy.mockRestore();
    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
  });

  describe("pluginDataPath", () => {
    it("appends .json when filename has no extension", () => {
      const p = pluginDataPath("playtime");
      expect(p).toMatch(/playtime\.json$/);
      expect(p).toContain("loadout/plugins");
    });

    it("does not double-append .json when filename already ends with it", () => {
      const p = pluginDataPath("playtime.json");
      expect(p).toMatch(/playtime\.json$/);
      expect(p.match(/\.json/g)?.length).toBe(1);
    });
  });

  describe("readPluginData", () => {
    it("returns parsed JSON when the file exists", async () => {
      readFileSpy.mockResolvedValue(JSON.stringify({ sessions: [1, 2, 3] }));
      const result = await readPluginData<{ sessions: number[] }>("/some/path.json", { sessions: [] });
      expect(result.sessions).toEqual([1, 2, 3]);
    });

    it("returns the default value when the file is missing (ENOENT)", async () => {
      readFileSpy.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      const result = await readPluginData("/missing.json", { sessions: [] });
      expect(result).toEqual({ sessions: [] });
    });

    it("returns the default value when the file contains non-JSON", async () => {
      readFileSpy.mockResolvedValue("not valid json {{");
      const result = await readPluginData("/bad.json", { sessions: [] });
      expect(result).toEqual({ sessions: [] });
    });
  });

  describe("writePluginData", () => {
    it("writes JSON via a tmp file and renames atomically", async () => {
      await writePluginData("/target/playtime.json", { sessions: [{ appId: "1" }] });

      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const [tmpPath, content] = writeFileSpy.mock.calls[0] as [string, string, string];
      expect(tmpPath).toMatch(/\.tmp$/);
      expect(JSON.parse(content)).toEqual({ sessions: [{ appId: "1" }] });

      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [from, to] = renameSpy.mock.calls[0] as [string, string];
      expect(from).toBe(tmpPath);
      expect(to).toBe("/target/playtime.json");
    });
  });
});
