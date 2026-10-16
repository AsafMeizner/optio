import { expect, test } from "@playwright/test";
import { API, liveTerminal } from "./fake-daemon";

test("session rail deletes without opening a row or a popup and stops running sessions before deleting", async ({
  page,
  request,
}) => {
  const live = await liveTerminal(request, {
    title: "Keep this session open",
    screen: "$ ready\r\n",
  });
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const host = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const create = async (title: string, stop = false) => {
    const response = await request.post(`${API}/api/local/terminals`, {
      data: { hostId: host.id, dir: "/Users/e2e/notes", title, spec: { kind: "shell" } },
    });
    expect(response.ok()).toBe(true);
    const { terminal } = await response.json();
    const state = async () =>
      (await (await request.get(`${API}/api/local/terminals/${terminal.id}`)).json()).terminal
        .state;
    await expect.poll(state).toBe("running");
    if (stop) {
      await request.post(`${API}/api/local/terminals/${terminal.id}/kill`);
      await expect.poll(state).toBe("exited");
    }
    return terminal;
  };
  const target = await create("Delete from sidebar");
  const current = await create("Delete current session", true);
  try {
    await page.goto(`/work/${live.id}`);
    const remove = page.getByRole("button", { name: `Delete ${target.title}`, exact: true });
    await expect(remove).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Delete Keep this session open", exact: true }),
    ).toBeEnabled();
    await remove.click();
    await expect(page.locator(`[data-terminal-id="${target.id}"]`)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/work/${live.id}$`));
    expect((await request.get(`${API}/api/local/terminals/${target.id}`)).status()).toBe(404);

    await page.goto(`/work/${current.id}`);
    await page.getByRole("button", { name: `Delete ${current.title}`, exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/work/${current.id}$`));
    expect((await request.get(`${API}/api/local/terminals/${current.id}`)).status()).toBe(404);
  } finally {
    await request.delete(`${API}/api/local/terminals/${target.id}`);
    await request.delete(`${API}/api/local/terminals/${current.id}`);
    await live.done();
  }
});
