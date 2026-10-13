// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStorageProvider } from "./local";

describe("local storage containment", () => {
  let root: string;
  let outside: string;
  let storage: LocalStorageProvider;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "portfolio-storage-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "portfolio-outside-"));
    vi.stubEnv("LOCAL_STORAGE_PATH", root);
    storage = new LocalStorageProvider();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it("supports nested upload, read, metadata and deletion", async () => {
    await storage.upload("imports/user/data.csv", Buffer.from("data"));
    expect((await storage.download("imports/user/data.csv")).toString()).toBe("data");
    expect(await storage.exists("imports/user/data.csv")).toBe(true);
    expect((await storage.getMetadata("imports/user/data.csv"))?.size).toBe(4);
    await storage.delete("imports/user/data.csv");
    expect(await storage.exists("imports/user/data.csv")).toBe(false);
  });
  it.each(["../escape", "nested/../../escape", "/etc/passwd", ".", "", "..\\escape", "bad\0name"])("rejects unsafe path %s for every filesystem operation", async (file) => {
    await expect(storage.upload(file, Buffer.from("bad"))).rejects.toThrow();
    await expect(storage.download(file)).rejects.toThrow();
    await expect(storage.delete(file)).rejects.toThrow();
    await expect(storage.exists(file)).rejects.toThrow();
    await expect(storage.getMetadata(file)).rejects.toThrow();
  });
  it("rejects directory and file symlinks without changing external data", async () => {
    await writeFile(path.join(outside, "secret"), "unchanged");
    await symlink(outside, path.join(root, "link"));
    await symlink(path.join(outside, "secret"), path.join(root, "file"));
    for (const file of ["link/secret", "file"]) {
      await expect(storage.upload(file, Buffer.from("bad"))).rejects.toThrow();
      await expect(storage.download(file)).rejects.toThrow();
      await expect(storage.delete(file)).rejects.toThrow();
    }
    expect(await readFile(path.join(outside, "secret"), "utf8")).toBe("unchanged");
  });
});
