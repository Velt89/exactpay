"use client";

import { payeeDirectoryAbi } from "@aevum-kit/aevum";
import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { short } from "@/lib/order";

const ZERO = "0x0000000000000000000000000000000000000000";
const normalize = (name: string) => name.trim().toLowerCase();

export default function DirectoryPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const directoryAddress = net.directory;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;

  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState<"register" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [lookupName, setLookupName] = useState("");
  const [nameResult, setNameResult] = useState<Address | null>(null);
  const [lookupAddress, setLookupAddress] = useState("");
  const [addressResult, setAddressResult] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const myName = useReadContract({
    address: directoryAddress,
    abi: payeeDirectoryAbi,
    functionName: "nameOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(directoryAddress && address) },
  });
  const registered = myName.data !== undefined && myName.data.length > 0 ? myName.data : undefined;

  async function onRegister() {
    if (!address || !directoryAddress) return;
    const name = normalize(nameInput);
    if (!name) {
      setError("Enter a name first.");
      return;
    }
    setError(null);
    setDone(null);
    setBusy("register");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: directoryAddress,
        abi: payeeDirectoryAbi,
        functionName: "register",
        args: [name],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. The name wasn't registered.");
      setDone(`You are now listed as "${name}". Payers will see this name next to your address.`);
      setNameInput("");
      myName.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRelease() {
    if (!address || !directoryAddress) return;
    setError(null);
    setDone(null);
    setBusy("release");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: directoryAddress,
        abi: payeeDirectoryAbi,
        functionName: "release",
        args: [],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. The name wasn't released.");
      setDone("Your name was released. Anyone can claim it now — including someone pretending to be you.");
      myName.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  async function lookupByName() {
    if (!directoryAddress) return;
    const name = normalize(lookupName);
    if (!name) return;
    setLookupError(null);
    setNameResult(null);
    setLooking(true);
    try {
      const found = await readContract(config, {
        address: directoryAddress,
        abi: payeeDirectoryAbi,
        functionName: "addressOf",
        args: [name],
        chainId: appChain.id,
      });
      setNameResult(found);
    } catch (e) {
      setLookupError(explain(e));
    } finally {
      setLooking(false);
    }
  }

  async function lookupByAddress() {
    if (!directoryAddress) return;
    const target = lookupAddress.trim();
    if (!isAddress(target)) {
      setLookupError("That isn't a valid address.");
      return;
    }
    setLookupError(null);
    setAddressResult(null);
    setLooking(true);
    try {
      const found = await readContract(config, {
        address: directoryAddress,
        abi: payeeDirectoryAbi,
        functionName: "nameOf",
        args: [target],
        chainId: appChain.id,
      });
      setAddressResult(found);
    } catch (e) {
      setLookupError(explain(e));
    } finally {
      setLooking(false);
    }
  }

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExactPay · Confirmation of Payee</p>
          <h1>Payee directory</h1>
          <p className="lede">
            Claim a name for your address so payers see <em>who</em> they are paying before they sign — and look up anyone else
            before you pay them.
          </p>
        </div>
      </div>

      <div className="notice warn" role="status">
        <strong>A listing is a claim, not a verification</strong>
        <span>
          Anyone can register any unclaimed name, first come first served. Always check the full address next to the name — a
          similar-looking name is not the same payee.
        </span>
      </div>

      {!directoryAddress ? (
        <div className="card empty">
          No PayeeDirectory configured for {net.label}. Set <code>NEXT_PUBLIC_DIRECTORY_{net.key.toUpperCase()}</code> in{" "}
          <code>web/.env.local</code>.
        </div>
      ) : (
        <div className="row">
          <section className="card stack" aria-label="Your listing" style={{ flex: "1 1 340px" }}>
            <h2>Your listing</h2>
            {!isConnected ? (
              <p className="empty">Connect a wallet to manage your listing.</p>
            ) : !onChain ? (
              <p className="empty">Switch your wallet to {appChain.name} ({appChain.id}) to manage your listing on this network.</p>
            ) : (
              <>
                <dl className="kv" style={{ fontSize: 13 }}>
                  <dt>Address</dt>
                  <dd>{address}</dd>
                  <dt>Your name</dt>
                  <dd>{myName.isLoading ? "…" : registered ?? "not registered"}</dd>
                </dl>
                {registered ? (
                  <>
                    <p className="fine">
                      To change your name, release <strong>{registered}</strong> first — one name per address. Releasing frees the
                      name for anyone to claim.
                    </p>
                    <div>
                      <button type="button" className="btn secondary" disabled={busy !== null} onClick={onRelease}>
                        {busy === "release" ? "Releasing… check your wallet" : `Release "${registered}"`}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="stack" style={{ gap: 6 }}>
                      <span className="fine">Name (stored lowercase, e.g. baiwor-bakery)</span>
                      <input
                        className="field"
                        placeholder="your-name"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                      />
                    </label>
                    <div>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy !== null || normalize(nameInput) === ""}
                        onClick={onRegister}
                      >
                        {busy === "register" ? "Registering… check your wallet" : "Register name"}
                      </button>
                    </div>
                  </>
                )}
                {error && (
                  <div className="notice bad" role="alert">
                    <strong>Didn&apos;t go through</strong>
                    <span>{error}</span>
                  </div>
                )}
                {done && (
                  <div className="notice good" role="status">
                    <span>{done}</span>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="card stack" aria-label="Look up a payee" style={{ flex: "1.3 1 420px" }}>
            <h2>Look up a payee</h2>
            <p className="sub">Check who you are about to pay, both ways.</p>

            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">By name</span>
              <input
                className="field"
                placeholder="baiwor-bakery"
                value={lookupName}
                onChange={(e) => setLookupName(e.target.value)}
              />
            </label>
            <div>
              <button type="button" className="btn secondary" disabled={looking || normalize(lookupName) === ""} onClick={lookupByName}>
                {looking ? "Looking…" : "Find address"}
              </button>
            </div>
            {nameResult !== null && (
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>{normalize(lookupName)}</dt>
                <dd>{nameResult === ZERO ? "not claimed by anyone" : nameResult}</dd>
              </dl>
            )}

            <div className="rule" />

            <label className="stack" style={{ gap: 6 }}>
              <span className="fine">By address</span>
              <input className="field" placeholder="0x…" value={lookupAddress} onChange={(e) => setLookupAddress(e.target.value)} />
            </label>
            <div>
              <button type="button" className="btn secondary" disabled={looking || lookupAddress.trim() === ""} onClick={lookupByAddress}>
                {looking ? "Looking…" : "Find name"}
              </button>
            </div>
            {addressResult !== null && (
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>{short(lookupAddress.trim())}</dt>
                <dd>{addressResult === "" ? "no registered name" : addressResult}</dd>
              </dl>
            )}

            {lookupError && (
              <div className="notice bad" role="alert">
                <strong>Lookup failed</strong>
                <span>{lookupError}</span>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
