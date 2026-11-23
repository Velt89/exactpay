"use client";

import { erc20Abi, getLogsChunked, invoicePayAbi } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { formatUnits, getAbiItem, isAddress, keccak256, parseUnits, toHex, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { newOrderId, orderLabel, short } from "@/lib/order";

const ZERO = "0x0000000000000000000000000000000000000000";
const STATUS_LABEL: Record<number, string> = { 1: "Open", 2: "Paid", 3: "Cancelled", 4: "Refunded" };

type InvoiceRow = {
  id: Hex;
  merchant: Address;
  expectedPayer: Address;
  paidBy: Address;
  amount: bigint;
  expiry: bigint;
  paidAt: bigint;
  memoHash: Hex;
  status: number;
};

export default function InvoicesPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoicePayAddress = net.invoicePay;
  const deployBlock = net.deployBlock;
  const config = useConfig();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  // ---- create form ----
  const [amountText, setAmountText] = useState("");
  const [hoursText, setHoursText] = useState("72");
  const [payerText, setPayerText] = useState("");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<Hex | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- list actions ----
  const [busyId, setBusyId] = useState<Hex | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mine = useQuery({
    queryKey: ["my-invoices", appChain.id, invoicePayAddress, address],
    enabled: Boolean(client && invoicePayAddress && address),
    queryFn: async () => {
      const created = await getLogsChunked(client!, {
        address: invoicePayAddress!,
        event: getAbiItem({ abi: invoicePayAbi, name: "InvoiceCreated" }),
        args: { merchant: address! },
        fromBlock: deployBlock ?? 0n,
      });
      const ids = [...created].reverse().map((l) => l.args.invoiceId!);
      const rows = await Promise.all(
        ids.map(async (id): Promise<InvoiceRow> => {
          const inv = await readContract(config, {
            address: invoicePayAddress!,
            abi: invoicePayAbi,
            functionName: "invoiceOf",
            args: [id],
            chainId: appChain.id,
          });
          return { id, ...inv };
        }),
      );
      return rows;
    },
  });

  async function onCreate() {
    if (!address || !invoicePayAddress) return;
    setCreateError(null);
    setCreatedId(null);
    setCopied(false);
    setCreating(true);
    try {
      const amount = parseUnits(amountText.trim(), token.decimals);
      if (amount <= 0n) throw new Error("The amount must be more than zero.");
      const hours = Number(hoursText);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("Expiry must be a positive number of hours.");
      const payerTrimmed = payerText.trim();
      if (payerTrimmed && !isAddress(payerTrimmed)) throw new Error("The expected payer isn't a valid address.");
      const expectedPayer = (payerTrimmed || ZERO) as Address;
      const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.floor(hours * 3600));
      const memoHash = memo.trim() ? keccak256(toHex(memo.trim())) : zeroHash;
      // Unguessable id: a random ref, namespaced to this merchant on-chain.
      const ref = newOrderId();
      const invoiceId = await readContract(config, {
        address: invoicePayAddress,
        abi: invoicePayAbi,
        functionName: "invoiceIdFor",
        args: [address, ref],
        chainId: appChain.id,
      });
      const { request } = await simulateContract(config, {
        account: address,
        address: invoicePayAddress,
        abi: invoicePayAbi,
        functionName: "createInvoice",
        args: [invoiceId, amount, expiry, expectedPayer, memoHash],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. The invoice wasn't created.");
      setCreatedId(invoiceId);
      mine.refetch();
    } catch (e) {
      setCreateError(explain(e));
    } finally {
      setCreating(false);
    }
  }

  async function copyLink(id: Hex) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/pay/${id}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function onCancel(row: InvoiceRow) {
    if (!address || !invoicePayAddress) return;
    setActionError(null);
    setBusyId(row.id);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: invoicePayAddress,
        abi: invoicePayAbi,
        functionName: "cancelInvoice",
        args: [row.id],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing changed.");
      mine.refetch();
    } catch (e) {
      setActionError(explain(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onRefund(row: InvoiceRow) {
    if (!address || !invoicePayAddress || !token.address) return;
    setActionError(null);
    setBusyId(row.id);
    try {
      // The contract pulls the refund from the merchant, so approve the exact amount first.
      const allowance = await readContract(config, {
        address: token.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, invoicePayAddress],
        chainId: appChain.id,
      });
      if (allowance < row.amount) {
        const approveHash = await writeContract(config, {
          address: token.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [invoicePayAddress, row.amount],
          chainId: appChain.id,
        });
        await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
      }
      const { request } = await simulateContract(config, {
        account: address,
        address: invoicePayAddress,
        abi: invoicePayAbi,
        functionName: "refundInvoice",
        args: [row.id],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was refunded.");
      mine.refetch();
    } catch (e) {
      setActionError(explain(e));
    } finally {
      setBusyId(null);
    }
  }

  const formValid = amountText.trim() !== "" && hoursText.trim() !== "" && onChain && Boolean(invoicePayAddress);

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ExactPay · Merchant</p>
          <h1>Your invoices</h1>
          <p className="lede">
            Issue an invoice with the amount fixed on-chain, share the link, and get paid exactly that amount — in Standard or
            Gasless mode.
          </p>
        </div>
      </div>

      {!invoicePayAddress ? (
        <div className="card empty">
          No InvoicePay configured for {net.label}. Set <code>NEXT_PUBLIC_INVOICEPAY_{net.key.toUpperCase()}</code> in{" "}
          <code>web/.env.local</code>.
        </div>
      ) : (
        <>
          <section className="card stack" aria-label="Create invoice">
            <h2>Create an invoice</h2>
            {!isConnected ? (
              <p className="empty">Connect a wallet to create invoices. The connected address becomes the merchant.</p>
            ) : !onChain ? (
              <p className="empty">Switch your wallet to {appChain.name} ({appChain.id}) to create invoices on this network.</p>
            ) : (
              <>
                <div className="grid-2">
                  <label className="stack" style={{ gap: 6 }}>
                    <span className="fine">Amount ({token.symbol})</span>
                    <input
                      className="field"
                      inputMode="decimal"
                      placeholder="1.05"
                      value={amountText}
                      onChange={(e) => setAmountText(e.target.value)}
                    />
                  </label>
                  <label className="stack" style={{ gap: 6 }}>
                    <span className="fine">Expires in (hours)</span>
                    <input
                      className="field"
                      inputMode="numeric"
                      placeholder="72"
                      value={hoursText}
                      onChange={(e) => setHoursText(e.target.value)}
                    />
                  </label>
                  <label className="stack" style={{ gap: 6 }}>
                    <span className="fine">Expected payer (optional — empty means anyone can pay)</span>
                    <input
                      className="field"
                      placeholder="0x…"
                      value={payerText}
                      onChange={(e) => setPayerText(e.target.value)}
                    />
                  </label>
                  <label className="stack" style={{ gap: 6 }}>
                    <span className="fine">Memo (optional — only its hash goes on-chain)</span>
                    <input
                      className="field"
                      placeholder="Consulting, October"
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      style={{ fontFamily: "var(--font-body)" }}
                    />
                  </label>
                </div>
                {createError && (
                  <div className="notice bad" role="alert">
                    <strong>Invoice wasn&apos;t created</strong>
                    <span>{createError}</span>
                  </div>
                )}
                {createdId && (
                  <div className="notice good" role="status">
                    <strong>Invoice {orderLabel(createdId)} created</strong>
                    <span>
                      Share this link with your payer:{" "}
                      <Link href={`/pay/${createdId}`}>
                        {typeof window !== "undefined" ? window.location.origin : ""}/pay/{createdId}
                      </Link>
                    </span>
                    <span>
                      <button type="button" className="btn small" onClick={() => copyLink(createdId)}>
                        {copied ? "Copied" : "Copy link"}
                      </button>
                    </span>
                  </div>
                )}
                <div>
                  <button type="button" className="btn big" disabled={!formValid || creating} onClick={onCreate}>
                    {creating ? "Creating… check your wallet" : "Create invoice"}
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="card flush" aria-label="My invoices">
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
              <h2>Issued by you</h2>
            </div>
            {actionError && (
              <div style={{ padding: "16px 20px" }}>
                <div className="notice bad" role="alert">
                  <strong>Action didn&apos;t go through</strong>
                  <span>{actionError}</span>
                </div>
              </div>
            )}
            {!address ? (
              <p className="empty">Connect a wallet to see your invoices.</p>
            ) : mine.isLoading ? (
              <p className="empty">Scanning InvoiceCreated events…</p>
            ) : mine.isError ? (
              <p className="empty">
                Couldn&apos;t read events: {(mine.error as Error).message}{" "}
                <button type="button" className="btn small" onClick={() => mine.refetch()}>
                  Try again
                </button>
              </p>
            ) : !mine.data || mine.data.length === 0 ? (
              <p className="empty">No invoices yet on {net.label}. Create your first one above.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Status</th>
                      <th className="right">Amount</th>
                      <th>Expires</th>
                      <th>Payer</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.data.map((row) => {
                      const expired = row.status === 1 && BigInt(Math.floor(Date.now() / 1000)) > row.expiry;
                      return (
                        <tr key={row.id}>
                          <td className="mono">
                            <Link href={`/pay/${row.id}`}>{orderLabel(row.id)}</Link>
                          </td>
                          <td>{expired ? "Expired" : (STATUS_LABEL[row.status] ?? row.status)}</td>
                          <td className="right num">
                            {formatUnits(row.amount, token.decimals)} {token.symbol}
                          </td>
                          <td className="num">{new Date(Number(row.expiry) * 1000).toLocaleString()}</td>
                          <td className="mono">
                            {row.status === 2 || row.status === 4
                              ? short(row.paidBy)
                              : row.expectedPayer !== ZERO
                                ? short(row.expectedPayer)
                                : "anyone"}
                          </td>
                          <td style={{ display: "flex", gap: 10 }}>
                            {row.status === 1 && !expired && (
                              <button
                                type="button"
                                className="btn small secondary"
                                disabled={busyId !== null}
                                onClick={() => onCancel(row)}
                              >
                                {busyId === row.id ? "Working…" : "Cancel"}
                              </button>
                            )}
                            {row.status === 2 && (
                              <button
                                type="button"
                                className="btn small secondary"
                                disabled={busyId !== null}
                                onClick={() => onRefund(row)}
                              >
                                {busyId === row.id ? "Working…" : "Refund"}
                              </button>
                            )}
                            {(row.status === 2 || row.status === 4) && (
                              <Link href={`/receipts/${row.id}?chain=${appChain.id}`}>Receipt</Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
