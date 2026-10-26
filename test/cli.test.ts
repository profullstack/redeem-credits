import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const run = (db: string, ...args: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args, "--db", db, "--json"], { encoding: "utf8" });

test("cli: mint, redeem, balance, spend, list, revoke, history", () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  try {
    const db = join(dir, "cli.sqlite");
    const minted = JSON.parse(run(db, "mint", "--unit", "minutes", "--amount", "1000", "--monthly", "--label", "Preshy").stdout);
    assert.match(minted.code, /^CR-/);
    assert.deepEqual(minted.grant, { unit: "minutes", amount: 1000, every: "month", months: null });

    const redeemed = run(db, "redeem", minted.code.toLowerCase(), "--user", "preshy");
    assert.equal(redeemed.status, 0);
    assert.equal(JSON.parse(redeemed.stdout).ok, true);

    const again = run(db, "redeem", minted.code, "--user", "preshy");
    assert.equal(again.status, 1);
    assert.equal(JSON.parse(again.stdout).reason, "already_redeemed");

    assert.equal(JSON.parse(run(db, "balance", "--user", "preshy", "--unit", "minutes").stdout).balance, 1000);
    assert.equal(JSON.parse(run(db, "spend", "--user", "preshy", "--unit", "minutes", "--amount", "25").stdout).balance, 975);
    assert.equal(JSON.parse(run(db, "grant", "--user", "preshy", "--unit", "minutes", "--amount", "5").stdout).ok, true);
    assert.equal(JSON.parse(run(db, "balance", "--user", "preshy", "--unit", "minutes").stdout).balance, 980);

    const list = JSON.parse(run(db, "list").stdout);
    assert.equal(list.length, 1);
    assert.equal(list[0].redemptions, 1);
    assert.equal(JSON.parse(run(db, "revoke", minted.id).stdout).ok, true);
    assert.equal(run(db, "revoke", "crd_missing").status, 1);
    assert.equal(JSON.parse(run(db, "history", "--user", "preshy").stdout).length, 3);

    // Plain-text mode works too.
    const text = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "list", "--db", db], { encoding: "utf8" });
    assert.match(text, /REVOKED/);
    assert.equal(run(db, "bogus").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
