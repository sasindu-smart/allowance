// Owner wallet connection for the Allowance dashboard (NEAR Wallet Selector, loaded from esm.sh).
//
// The OWNER signs approve / reject / pause / unpause in their own wallet. No private key ever
// touches this app or the server. After signing, the dashboard sends the transaction hash to the
// server, which looks the transaction up on the NEAR RPC and checks it before updating anything.
//
// If a library fails to load (offline, blocked CDN, wallet not available) the dashboard keeps
// working: the buttons simply fall back to the server's own signing route.

const V = "8.10.0";
// One near-api-js copy for every wallet package. Without this, esm.sh can load two different
// versions (one for the selector, one for the wallet's own SDK) and signing fails with
// "Class e is missing in schema: publicKey". Try another version with /app?napi=5.1.1
let NAPI = "4.0.3";
try { NAPI = new URLSearchParams(location.search).get("napi") || NAPI; } catch {}
const DEPS = `?deps=near-api-js@${NAPI}`;
const CORE = `https://esm.sh/@near-wallet-selector/core@${V}${DEPS}`;
const mod = (name) => `https://esm.sh/@near-wallet-selector/${name}@${V}${DEPS}`;
const WALLETS = [
  { id: "meteor-wallet", label: "Meteor Wallet", note: "Popup. Tested on testnet.", pkg: mod("meteor-wallet"), fn: "setupMeteorWallet" },
  { id: "sender", label: "Sender", note: "Browser extension.", pkg: mod("sender"), fn: "setupSender" },
  { id: "nightly", label: "Nightly", note: "Browser extension.", pkg: mod("nightly"), fn: "setupNightly" },
  { id: "here-wallet", label: "HERE Wallet", note: "Mobile app or web.", pkg: mod("here-wallet"), fn: "setupHereWallet" },
  { id: "bitget-wallet", label: "Bitget Wallet", note: "Browser extension.", pkg: mod("bitget-wallet"), fn: "setupBitgetWallet" },
  { id: "welldone-wallet", label: "WELLDONE", note: "Browser extension.", pkg: mod("welldone-wallet"), fn: "setupWelldoneWallet" },
  { id: "my-near-wallet", label: "MyNearWallet", note: "Redirects. Its testnet site may be down.", pkg: mod("my-near-wallet"), fn: "setupMyNearWallet" },
];

let cfg = null, selector = null, loading = null;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(state()));

function active() {
  try { return selector?.store.getState().accounts.find((a) => a.active)?.accountId || null; } catch { return null; }
}
function state() {
  const account = active();
  return { ready: !!selector, account, isOwner: !!account && !!cfg && account === cfg.owner, owner: cfg?.owner || null };
}

async function load() {
  if (selector) return selector;
  if (loading) return loading;
  loading = (async () => {
    const { setupWalletSelector } = await import(CORE);
    const modules = [];
    const loaded = await Promise.allSettled(WALLETS.map((w) => import(w.pkg).then((m) => m[w.fn]())));
    loaded.forEach((r, i) => {
      const w = WALLETS[i];
      if (r.status === "fulfilled") { modules.push(r.value); w.ok = true; }
      else { w.ok = false; console.warn("Wallet module unavailable:", w.label, r.reason); }
    });
    if (!modules.length) throw new Error("No wallet libraries could be loaded. Check your internet connection.");
    selector = await setupWalletSelector({ network: cfg.network, modules });
    selector.store.observable.subscribe(emit);
    return selector;
  })();
  try { return await loading; } finally { loading = null; }
}

window.Wallet = {
  options: () => WALLETS.filter((w) => w.ok !== false).map((w) => ({ id: w.id, label: w.label, note: w.note })),
  state,
  onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
  async init(config) {
    cfg = config;
    if (!cfg.walletReady) return state();
    try { await load(); } catch (e) { console.warn(e); }
    emit();
    return state();
  },
  async connect(walletId) {
    await load();
    const wallet = await selector.wallet(walletId);
    await wallet.signIn({ contractId: cfg.contractId, methodNames: ["approve", "reject", "pause", "unpause", "set_policy"], accounts: [] });
    emit();
    return state();
  },
  async disconnect() {
    if (!selector) return;
    try { await (await selector.wallet()).signOut(); } catch (e) { console.warn(e); }
    emit();
  },
  // Sign one owner action. Returns the transaction hash, or null when the wallet will
  // redirect and come back (the app then reads ?transactionHashes=... on load).
  async sign(methodName, args) {
    await load();
    const wallet = await selector.wallet();
    const out = await wallet.signAndSendTransaction({
      receiverId: cfg.contractId,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas: "30000000000000", deposit: "0" } }],
    });
    return out?.transaction?.hash || out?.transaction_outcome?.id || null;
  },
};
window.dispatchEvent(new Event("wallet-module-ready"));
