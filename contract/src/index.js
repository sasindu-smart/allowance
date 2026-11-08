// Allowance smart contract (near-sdk-js).
//
// This file is a thin wrapper. ALL rules live in policy-core.js, which has no SDK imports
// and is covered by `npm test`. The wrapper only: reads who called, the time and the balance,
// calls the core, stores the new state, writes the log lines, and sends the transfer.
//
// The whole state is kept as one JSON string (near-sdk-js needs every field to have a
// non-null default, and a string is the simplest thing that always round-trips).
//
// Who can do what:
//   agent    -> request_payment
//   owner    -> approve, reject, set_policy, set_agent, set_guardian, pause, unpause
//   guardian -> pause only (a circuit breaker; it can never pay, approve or unpause)
//   anyone -> get_state (view), and can send NEAR to this account to fund it

import { NearBindgen, near, call, view, initialize, NearPromise } from "near-sdk-js";
import {
  NEAR, defaultPolicy, newState,
  requestPayment as coreRequestPayment, approve as coreApprove, reject as coreReject,
  setPolicy as coreSetPolicy, setAgent as coreSetAgent,
  pause as corePause, unpause as coreUnpause, setGuardian as coreSetGuardian,
} from "./policy-core.js";

// Kept back so the account can always pay for its own storage.
const RESERVE = NEAR / 2n;

@NearBindgen({})
class Allowance {
  constructor() {
    this.data = "";
  }

  load() {
    if (!this.data) throw new Error("Contract is not initialized");
    return JSON.parse(this.data);
  }

  save(s) {
    this.data = JSON.stringify(s);
  }

  ctx() {
    const total = near.accountBalance();
    return {
      caller: near.predecessorAccountId(),
      now: near.blockTimestamp(),
      balance: total > RESERVE ? total - RESERVE : 0n,
    };
  }

  // Save state, emit logs, and send the transfer (if any).
  finish(s, out) {
    this.save(s);
    for (const line of out.logs) near.log(line);
    if (out.transfer) {
      return NearPromise.new(out.transfer.to).transfer(out.transfer.amount);
    }
    return out.result ?? null;
  }

  @initialize({})
  init({ owner, agent, guardian, allowed, blocked, maxPerHour, recipientDailyCaps }) {
    const policy = defaultPolicy();
    policy.allowed = allowed || [];
    policy.blocked = blocked || [];
    policy.maxPerHour = maxPerHour ?? 0;
    policy.recipientDailyCaps = recipientDailyCaps || {};
    this.save(newState(owner, agent, policy, guardian ?? null));
  }

  @call({})
  request_payment({ to, amount, memo }) {
    const s = this.load();
    return this.finish(s, coreRequestPayment(s, this.ctx(), { to, amount, memo }));
  }

  @call({})
  approve({ id }) {
    const s = this.load();
    return this.finish(s, coreApprove(s, this.ctx(), id));
  }

  @call({})
  reject({ id }) {
    const s = this.load();
    return this.finish(s, coreReject(s, this.ctx(), id));
  }

  @call({})
  set_policy({ policy }) {
    const s = this.load();
    return this.finish(s, coreSetPolicy(s, this.ctx(), policy));
  }

  @call({})
  set_agent({ agent }) {
    const s = this.load();
    return this.finish(s, coreSetAgent(s, this.ctx(), agent));
  }

  // Circuit breaker: owner or guardian pauses, only the owner unpauses.
  @call({})
  pause({ reason }) {
    const s = this.load();
    return this.finish(s, corePause(s, this.ctx(), reason));
  }

  @call({})
  unpause() {
    const s = this.load();
    return this.finish(s, coreUnpause(s, this.ctx()));
  }

  @call({})
  set_guardian({ guardian }) {
    const s = this.load();
    return this.finish(s, coreSetGuardian(s, this.ctx(), guardian ?? null));
  }

  @view({})
  get_state() {
    return this.load();
  }
}
