import { execFile } from "node:child_process";

// Real NEAR TESTNET payments using near-cli-rs.
// Signing happens inside the CLI using the key in YOUR OS keychain,
// so no private key ever touches this repo or a .env file.
//
// Docs for the command used: https://docs.near.org/tools/cli
//   near tokens <from> send-near <to> '<amount> NEAR' network-config testnet sign-with-keychain send

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function parseRecipientMap(text = "") {
  const map = {};
  for (const pair of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [logical, real] = pair.split("=").map((s) => s.trim());
    if (logical && real) map[logical] = real;
  }
  return map;
}

// Pure + testable: validates inputs and builds the CLI argument list.
export function buildArgs({ from, to, amount, scale }) {
  if (!ACCOUNT_RE.test(from) || from.length > 64) throw new Error("Invalid sender account");
  if (!ACCOUNT_RE.test(to) || to.length > 64) throw new Error("Invalid recipient account");
  if (!to.endsWith(".testnet")) throw new Error("Testnet mode only sends to .testnet accounts");
  const onchain = Number((amount * scale).toFixed(6));
  if (!(onchain > 0) || onchain > 1) throw new Error("On-chain amount out of safe range (max 1 NEAR in testnet mode)");
  return [
    "tokens", from, "send-near", to, `${onchain} NEAR`,
    "network-config", "testnet", "sign-with-keychain", "send",
  ];
}

// On Windows we run through a shell (npm installs "near" as a .cmd shim), and a shell
// splits "0.05 NEAR" into two words. Quote any argument that contains a space.
// Safe: every argument was already validated by buildArgs.
export function quoteForShell(args) {
  return args.map((a) => (a.includes(" ") ? `"${a}"` : a));
}

export function createNearTestnetPayments({ accountId, recipientMap = {}, scale = 0.01 }) {
  if (!accountId) throw new Error("NEAR_ACCOUNT_ID is not set (see .env.example)");
  return {
    name: "near-testnet",
    account: accountId,
    async pay({ to, amount }) {
      const realTo = recipientMap[to];
      if (!realTo) throw new Error(`No testnet account mapped for "${to}". Set RECIPIENT_MAP in .env`);
      const args = buildArgs({ from: accountId, to: realTo, amount, scale });
      const useShell = process.platform === "win32";
      const cmdArgs = useShell ? quoteForShell(args) : args;
      const out = await new Promise((resolve, reject) => {
        execFile("near", cmdArgs, { shell: useShell, timeout: 120000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message).toString().slice(0, 300)));
          resolve(stdout.toString() + stderr.toString());
        });
      });
      const m = out.match(/Transaction ID:\s*([A-Za-z0-9]+)/);
      if (!m) throw new Error("Payment sent but no transaction id found in CLI output");
      return { ok: true, txHash: m[1] };
    },
  };
}
