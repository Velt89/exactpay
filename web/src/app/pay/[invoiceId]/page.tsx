"use client";

import { addressUrl, authorizationWindow, checkoutTypedData, erc20Abi, invoicePayAbi, payeeDirectoryAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatUnits, isHex, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { orderLabel, short } from "@/lib/order";

type Mode = "gasless" | "standard";
type Phase = "idle" | "working" | "done" | "error";

const ZERO = "0x0000000000000000000000000000000000000000";
const STATUS_LABEL: Record<number, string> = { 1: "Open", 2: "Paid", 3: "Cancelled", 4: "Refunded" };

const STEPS: Record<Mode, { title: string; who: string }[]> = {
  gasless: [
    { title: "Sign payment authorization", who: "EIP-3009 · your wallet signs, no gas" },
    { title: "Relayer submits transaction", who: "payWithAuthorization · the relayer pays gas" },
    { title: "Confirmed on Aevum", who: "The Paid event is your receipt" },
  ],
  standard: [
    { title: "Approve tUSD8", who: "approve(InvoicePay, exact invoice amount) · you pay gas" },
    { title: "Pay invoice", who: "InvoicePay.pay(invoiceId) · you pay gas" },
    { title: "Confirmed on Aevum", who: "The Paid event is your receipt" },
  ],
};

export default function PayPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoicePayAddress = net.invoicePay;
  const directoryAddress = net.directory;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params.invoiceId;
  const validId = isHex(invoiceId) && invoiceId.length === 66;

  const [mode, setMode] = useState<Mode>("gasless");
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const invoice = useReadContract({
    address: invoicePayAddress,
    abi: invoicePayAbi,
    functionName: "invoiceOf",
    args: validId ? [invoiceId as Hex] : undefined,
    chainId: appChain.id,
    query: { enabled: validId && Boolean(invoicePayAddress) },
  });
  const inv = invoice.data;
  const merchant = inv && inv.status !== 0 ? inv.merchant : undefined;

  // Confirmation of Payee: the merchant's registered name, if they claimed one.
  const payeeName = useReadContract({
    address: directoryAddress,
    abi: payeeDirectoryAbi,
    functionName: "nameOf",
    args: merchant ? [merchant] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(directoryAddress && merchant) },
  });
  const name = payeeName.data && payeeName.data.length > 0 ? payeeName.data : undefined;

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () => (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean; relayer: string | null }>,
  });
  const gaslessAvailable = relay.data?.enabled ?? false;
  useEffect(() => {
    if (relay.data) setMode(relay.data.enabled ? "gasless" : "standard");
  }, [relay.data]);

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  const amount = inv?.amount ?? 0n;
  const enoughBalance = balance.data === undefined || balance.data >= amount;
  const busy = phase === "working";

  const expired = inv !== undefined && inv.status === 1 && BigInt(now) > inv.expiry;
  const wrongPayer =
    inv !== undefined && inv.expectedPayer !== ZERO && address !== undefined && address.toLowerCase() !== inv.expectedPayer.toLowerCase();
  const restricted = inv !== undefined && inv.expectedPayer !== ZERO;
  const needsConfirm = Boolean(name);
  const blocked =
    !inv || inv.status !== 1 || expired || wrongPayer || (needsConfirm && !confirmed) || !enoughBalance;

  function reset(nextMode = mode) {
    setMode(nextMode);
    setStep(0);
    setPhase("idle");
    setError(null);
    setTxHash(null);
    setBlock(null);
  }

  /** Stop before any signature or gas is spent if this invoice is no longer payable. */
  async function assertPayable(id: Hex) {
    if (!invoicePayAddress) return;
    const fresh = await readContract(config, {
      address: invoicePayAddress,
      abi: invoicePayAbi,
      functionName: "invoiceOf",
      args: [id],
      chainId: appChain.id,
    });
    if (fresh.status === 0) throw new Error("This invoice doesn't exist.");
    if (fresh.status !== 1) throw new Error(`This invoice is ${STATUS_LABEL[fresh.status]?.toLowerCase() ?? "closed"} and can't be paid.`);
    if (BigInt(Math.floor(Date.now() / 1000)) > fresh.expiry) throw new Error("This invoice has expired.");
    if (fresh.expectedPayer !== ZERO && address && fresh.expectedPayer.toLowerCase() !== address.toLowerCase()) {
      throw new Error("This invoice is addressed to a different payer.");
    }
  }

  async function payGasless() {
    if (!address || !invoicePayAddress || !token.address || !validId) return;
    const id = invoiceId as Hex;
    await assertPayable(id);
    // 1. Sign. The nonce comes from the contract and ties this signature to this invoice.
    const nonce = await readContract(config, {
      address: invoicePayAddress,
      abi: invoicePayAbi,
      functionName: "authorizationNonce",
      args: [id],
      chainId: appChain.id,
    });
    const { validAfter, validBefore } = authorizationWindow(600);
    const signature = await signTypedData(config, {
      account: address,
      ...checkoutTypedData(appChain.id, token.address, { from: address, to: invoicePayAddress, value: amount, validAfter, validBefore, nonce }),
    });
    setStep(1);
    // 2. Hand it to the relayer (web/src/app/api/relay/route.ts). The relayer reads the
    // amount from the invoice on-chain; the request carries no amount at all.
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: appChain.id,
        invoiceId: id,
        from: address,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "The relayer didn't accept the payment.");
    setTxHash(data.hash);
    setStep(2);
    return data.hash;
  }

  async function payStandard() {
    if (!address || !invoicePayAddress || !token.address || !validId) return;
    const id = invoiceId as Hex;
    await assertPayable(id);
    // 1. Approve exactly the invoice amount, never an unlimited amount.
    const allowance = await readContract(config, {
      address: token.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, invoicePayAddress],
      chainId: appChain.id,
    });
    if (allowance < amount) {
      const approveHash = await writeContract(config, {
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [invoicePayAddress, amount],
        chainId: appChain.id,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    setStep(1);
    // 2. Pay. The contract pulls exactly the invoice amount; there is no amount to type.
    // Simulate first: a revert shows up here with its reason, before the wallet asks for gas.
    const { request } = await simulateContract(config, {
      account: address,
      address: invoicePayAddress,
      abi: invoicePayAbi,
      functionName: "pay",
      args: [id],
      chainId: appChain.id,
    });
    const hash = await writeContract(config, request);
    setTxHash(hash);
    setStep(2);
    return hash;
  }

  async function onPay() {
    setError(null);
    setPhase("working");
    setStep(0);
    try {
      const hash = mode === "gasless" ? await payGasless() : await payStandard();
      if (!hash) throw new Error("Connect your wallet first.");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
      setBlock(receipt.blockNumber);
      setStep(3);
      setPhase("done");
      balance.refetch();
      invoice.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  if (!validId) {
    return (
      <main className="shell">
        <h1>Invoice not found</h1>
        <p className="lede">That invoice id isn&apos;t valid. Invoice ids are 32-byte hex values (0x + 64 characters).</p>
      </main>
    );
  }

  const cta = (() => {
    if (!isConnected) return "Connect a wallet to pay";
    if (!onChain) return "Switch network to pay";
    if (!invoicePayAddress) return "Deploy InvoicePay first";
    if (phase === "done") return "Paid";
    if (phase === "error") return mode === "gasless" ? "Sign again" : "Try again";
    if (busy) return ["Check your wallet…", mode === "gasless" ? "Waiting for relayer…" : "Check your wallet…", "Confirming…"][step] ?? "Working…";
    return mode === "gasless"
      ? `Sign & pay ${formatUnits(amount, token.decimals)} ${token.symbol}`
      : `Approve & pay ${formatUnits(amount, token.decimals)} ${token.symbol}`;
  })();
  const ctaDisabled = !onChain || !invoicePayAddress || busy || phase === "done" || blocked;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExactPay · InvoicePay</p>
          <h1>Pay invoice {orderLabel(invoiceId as Hex)}</h1>
          <p className="lede">The amount was fixed by the merchant on-chain. You can&apos;t overpay, underpay, or pay it twice.</p>
        </div>
      </div>

      <div className="row">
        <section className="card stack" aria-label="Invoice" style={{ flex: "1 1 340px" }}>
          <div className="check-top" style={{ alignItems: "baseline" }}>
            <h2>Invoice</h2>
            <span className="mono" style={{ color: "var(--text-muted)" }}>{short(invoiceId)}</span>
          </div>
          {!invoicePayAddress ? (
            <p className="empty">
              No InvoicePay configured for {net.label}. Set <code>NEXT_PUBLIC_INVOICEPAY_{net.key.toUpperCase()}</code> in{" "}
              <code>web/.env.local</code>.
            </p>
          ) : invoice.isLoading ? (
            <p className="empty">Reading InvoicePay.invoiceOf…</p>
          ) : invoice.isError ? (
            <div className="stack">
              <span className="status-pill warn">Can&apos;t check</span>
              <p style={{ color: "var(--text-muted)" }}>
                Couldn&apos;t read the invoice from {appChain.name}. The RPC may be busy.{" "}
                <button type="button" className="btn small" onClick={() => invoice.refetch()}>
                  Try again
                </button>
              </p>
            </div>
          ) : !inv || inv.status === 0 ? (
            <div className="stack">
              <span className="status-pill warn">Not found</span>
              <p style={{ color: "var(--text-muted)" }}>No invoice with this id exists on {appChain.name}.</p>
            </div>
          ) : (
            <>
              <div className="lines">
                <div className="line" style={{ alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600 }}>Amount due</span>
                  <span className="total">
                    {formatUnits(inv.amount, token.decimals)} <small>{token.symbol}</small>
                  </span>
                </div>
              </div>
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>Status</dt>
                <dd>{expired && inv.status === 1 ? "Expired" : (STATUS_LABEL[inv.status] ?? inv.status)}</dd>
                <dt>Merchant</dt>
                <dd>
                  {hasExplorer ? (
                    <a href={addressUrl(inv.merchant)} target="_blank" rel="noreferrer">{inv.merchant}</a>
                  ) : (
                    inv.merchant
                  )}
                </dd>
                <dt>Expires</dt>
                <dd>{new Date(Number(inv.expiry) * 1000).toLocaleString()}</dd>
                {restricted && (
                  <>
                    <dt>Only payable by</dt>
                    <dd>{inv.expectedPayer}</dd>
                  </>
                )}
                {inv.status === 2 && (
                  <>
                    <dt>Paid by</dt>
                    <dd>{inv.paidBy}</dd>
                    <dt>Paid at</dt>
                    <dd>{new Date(Number(inv.paidAt) * 1000).toLocaleString()}</dd>
                  </>
                )}
                <dt>Your balance</dt>
                <dd>{balance.data !== undefined ? `${formatUnits(balance.data, token.decimals)} ${token.symbol}` : "—"}</dd>
              </dl>

              {inv.status === 2 && (
                <div className="notice good" role="status">
                  <strong>Paid</strong>
                  <span>
                    Paid by {short(inv.paidBy)} at {new Date(Number(inv.paidAt) * 1000).toLocaleString()}.{" "}
                    <Link href={`/receipts/${invoiceId}?chain=${appChain.id}`}>View receipt</Link>
                  </span>
                </div>
              )}
              {inv.status === 3 && (
                <div className="notice warn" role="status">
                  <strong>Cancelled</strong>
                  <span>The merchant cancelled this invoice. It can&apos;t be paid.</span>
                </div>
              )}
              {inv.status === 4 && (
                <div className="notice warn" role="status">
                  <strong>Refunded</strong>
                  <span>This invoice was paid and then refunded in full to the payer.</span>
                </div>
              )}
              {expired && (
                <div className="notice bad" role="alert">
                  <strong>Expired</strong>
                  <span>This invoice expired at {new Date(Number(inv.expiry) * 1000).toLocaleString()} and can no longer be paid.</span>
                </div>
              )}
              {wrongPayer && inv.status === 1 && (
                <div className="notice bad" role="alert">
                  <strong>Wrong payer</strong>
                  <span>
                    This invoice is addressed to {short(inv.expectedPayer)}. Connect that wallet to pay it — the contract rejects
                    everyone else.
                  </span>
                </div>
              )}
              {restricted && !address && inv.status === 1 && (
                <div className="notice warn" role="status">
                  <strong>Restricted invoice</strong>
                  <span>Only {short(inv.expectedPayer)} can pay this invoice.</span>
                </div>
              )}
            </>
          )}
        </section>

        <section className="card stack" aria-label="Payment" style={{ flex: "1.3 1 420px" }}>
          <div className="stack" style={{ gap: 10 }}>
            <h2>Confirmation of Payee</h2>
            {!directoryAddress ? (
              <div className="notice warn" role="status">
                <strong>No payee directory configured</strong>
                <span>
                  Set <code>NEXT_PUBLIC_DIRECTORY_{net.key.toUpperCase()}</code> to check the merchant&apos;s registered name before
                  paying. Until then, verify the merchant address out-of-band.
                </span>
              </div>
            ) : payeeName.isLoading ? (
              <p className="fine">Looking up the merchant in the PayeeDirectory…</p>
            ) : name ? (
              <>
                <p style={{ fontSize: 17 }}>
                  You are paying <strong>{name}</strong>
                </p>
                <p className="mono" style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>{merchant}</p>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>I confirm the payee name and address match who I intend to pay</span>
                </label>
                <p className="fine">
                  A directory listing is a claim, not a verification: anyone can register a name. A similar-looking name is not the
                  same payee — check the address.
                </p>
              </>
            ) : merchant ? (
              <div className="notice warn" role="status">
                <strong>Unregistered payee</strong>
                <span>
                  {short(merchant)} has no registered name in the PayeeDirectory. Verify this address out-of-band (the merchant&apos;s
                  own site, a signed message, a phone call) before you pay.
                </span>
              </div>
            ) : (
              <p className="fine">The payee check runs once the invoice is loaded.</p>
            )}
          </div>

          <div className="modes" role="radiogroup" aria-label="Payment mode">
            {(
              [
                { id: "gasless", title: "Gasless", tag: "EIP-3009", desc: relay.isLoading ? "Checking whether the gasless relayer is available…" : gaslessAvailable ? "Sign once. A relayer submits it. You need no tQDAY." : "Off: set RELAYER_PRIVATE_KEY in web/.env.local to enable." },
                { id: "standard", title: "Standard", tag: "approve + pay", desc: "Two wallet transactions. You pay gas in tQDAY." },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                className="mode"
                aria-checked={mode === m.id}
                disabled={busy || (m.id === "gasless" && !gaslessAvailable)}
                onClick={() => reset(m.id)}
              >
                <span className="mode-top">
                  {m.title}
                  <span className="tag">{m.tag}</span>
                </span>
                <span className="mode-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          <ol className="steps">
            {STEPS[mode].map((s, i) => {
              const done = step > i;
              const active = busy && step === i;
              return (
                <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                  <div className="step-dot">{done ? <CheckIcon /> : i + 1}</div>
                  <div className="step-body">
                    <div className="step-top">
                      <span className="step-title">{s.title}</span>
                      <span className="step-state">{done ? "Done" : active ? "In progress…" : "Waiting"}</span>
                    </div>
                    <p className="step-who">{s.who}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          {!enoughBalance && inv?.status === 1 && phase !== "done" && (
            <div className="notice warn" role="status">
              <strong>Not enough {token.symbol}</strong>
              <span>
                This invoice needs {formatUnits(amount, token.decimals)} {token.symbol}. See the <Link href="/">Setup</Link> section for
                how to get test tokens.
              </span>
            </div>
          )}

          {error && (
            <div className="notice bad" role="alert">
              <strong>Payment didn&apos;t go through</strong>
              <span>{error}</span>
            </div>
          )}

          {phase === "done" && txHash && (
            <div className="notice good" role="status">
              <div className="row-between">
                <strong>
                  Paid {formatUnits(amount, token.decimals)} {token.symbol}
                  {block !== null ? ` · confirmed in block ${block.toLocaleString("en-US")}` : ""}
                </strong>
                <span style={{ display: "flex", gap: 16 }}>
                  {hasExplorer && (
                    <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                      Explorer
                    </a>
                  )}
                  <Link href={`/receipts/${invoiceId}?tx=${txHash}&chain=${appChain.id}`}>View receipt</Link>
                </span>
              </div>
            </div>
          )}

          <button type="button" className="btn big block" disabled={ctaDisabled} onClick={onPay}>
            {cta}
          </button>
          <p className="fine">
            {mode === "gasless"
              ? "The signature is valid for 10 minutes, for this exact amount, and only for this invoice."
              : "The approval is for the exact invoice amount, never unlimited."}
          </p>
        </section>
      </div>
    </main>
  );
}
