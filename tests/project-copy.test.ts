import { afterEach, describe, expect, it, vi } from "vitest";
import { getTemplate } from "../src/data/templates";
import { projectsApi } from "../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("cloud project duplication", () => {
  it("copies uploaded media once into the new project so deleting the original cannot break it", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const original = structuredClone(getTemplate("cobalt").document);
    original.profile.photo = "/api/assets/asset_original";
    original.sections[0].image = original.profile.photo;
    const requests: Array<{ path: string; method: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: input, method: init?.method || "GET", body });
        if (input === "/api/assets/asset_original")
          return new Response(
            new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            { headers: { "Content-Type": "image/png" } },
          );
        if (input.endsWith("/assets"))
          return Response.json({ url: "/api/assets/asset_independent" });
        return Response.json({
          project: { id: "project_copy", revision: 0, document: body.document },
        });
      }),
    );
    const { project } = await projectsApi.create(original);
    expect(requests.filter((r) => r.path.endsWith("/assets"))).toHaveLength(1);
    expect(requests[0].body.document.sections[0].image).toBe("");
    expect(project.document.sections[0].image).toBe(
      "/api/assets/asset_independent",
    );
    expect(project.document.profile.photo).toBe(
      "/api/assets/asset_independent",
    );
    expect(original.sections[0].image).toBe("/api/assets/asset_original");
  });

  it("removes an incomplete copy and preserves its source when an image is unavailable", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const original = structuredClone(getTemplate("cobalt").document);
    original.sections[0].image = "/api/assets/asset_missing";
    const requests: Array<{ path: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        requests.push({ path: input, method: init?.method });
        if (input === "/api/assets/asset_missing")
          return new Response("Not found", { status: 404 });
        return Response.json({
          project: { id: "project_incomplete", revision: 0 },
        });
      }),
    );
    await expect(projectsApi.create(original)).rejects.toThrow(
      "image could not be copied",
    );
    expect(requests).toContainEqual({
      path: "/api/projects/project_incomplete",
      method: "DELETE",
    });
    expect(original.sections[0].image).toBe("/api/assets/asset_missing");
  });
});
