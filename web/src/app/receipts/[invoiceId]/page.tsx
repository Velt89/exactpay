"use client";

import { addressUrl, getLogsChunked, invoicePayAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { formatUnits, getAbiItem, isHash, isHex, type Hex, type PublicClient } from "viem";
import { usePublicClient, useReadContract, useTransactionReceipt } from "wagmi";
import { useToken } from "@/components/useToken";
import { networkByChainId } from "@/lib/env";
import { useNetwork } from "@/lib/network";
import { orderLabel } from "@/lib/order";

const STATUS_LABEL: Record<number, string> = { 1: "Open", 2: "Paid", 3: "Cancelled", 4: "Refunded" };

export default function ReceiptPage() {
  const { net: appNet } = useNetwork();
  const params = useParams<{ invoiceId: string }>();
  const search = useSearchParams();
  // Receipt links carry their chain, so they still work after you switch networks.
  const net = networkByChainId(Number(search.get("chain"))) ?? appNet;
  const appChain = net.chain;
  const invoicePayAddress = net.invoicePay;
  const deployBlock = net.deployBlock;
  const hasExplorer = net.hasExplorer;
  const invoiceId = params.invoiceId;
  const rawTx = search.get("tx");
  // Anything else in ?tx= is ignored, never shown: a receipt must not display text from the URL.
  const tx = rawTx && isHash(rawTx) ? rawTx : undefined;
  const validId = isHex(invoiceId) && invoiceId.length === 66;
  const token = useToken();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;

  const invoice = useReadContract({
    address: invoicePayAddress,
    abi: invoicePayAbi,
    functionName: "invoiceOf",
    args: validId ? [invoiceId as Hex] : undefined,
    chainId: appChain.id,
    query: { enabled: validId && Boolean(invoicePayAddress) },
  });

  // The Paid event is the receipt: find it on-chain rather than trusting the link.
  const paidLog = useQuery({
    queryKey: ["paid-log", appChain.id, invoicePayAddress, invoiceId],
    enabled: Boolean(client && invoicePayAddress && validId),
    queryFn: async () => {
      const logs = await getLogsChunked(client!, {
        address: invoicePayAddress!,
        event: getAbiItem({ abi: invoicePayAbi, name: "Paid" }),
        args: { invoiceId: invoiceId as Hex },
        fromBlock: deployBlock ?? 0n,
      });
      return logs.at(-1) ?? null;
    },
  });
  const foundTx = paidLog.data?.transactionHash;
  // Only show transaction details if the transaction in the link really is the payment.
  const txMatches = Boolean(tx && foundTx && tx.toLowerCase() === foundTx.toLowerCase());
  const shownTx = txMatches ? tx : foundTx;
  const receipt = useTransactionReceipt({ hash: shownTx, chainId: appChain.id, query: { enabled: Boolean(shownTx) } });

  if (!validId) {
    return (
      <main className="shell">
        <h1>Receipt not found</h1>
        <p className="lede">That invoice id isn&apos;t valid. Invoice ids are 32-byte hex values (0x + 64 characters).</p>
      </main>
    );
  }

  const inv = invoice.data;
  const status = inv?.status ?? 0;
  const paid = status === 2 || status === 4;

  return (
    <main className="shell" style={{ maxWidth: 760 }}>
      <div>
        <p className="eyebrow">Receipt · read from {appChain.name}</p>
        <h1>Invoice {orderLabel(invoiceId as Hex)}</h1>
      </div>

      <section className="card stack">
        {!invoicePayAddress ? (
          <div className="stack">
            <span className="status-pill warn">Can&apos;t check</span>
            <p style={{ color: "var(--text-muted)" }}>No InvoicePay is configured for {appChain.name} in this app.</p>
          </div>
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
        ) : status === 0 ? (
          <div className="stack">
            <span className="status-pill warn">Not found</span>
            <p style={{ color: "var(--text-muted)" }}>
              No invoice with this id exists on {appChain.name}. Check the id and the network.
            </p>
          </div>
        ) : (
          <>
            <div className="check-top" style={{ alignItems: "center" }}>
              <span className={`status-pill ${status === 2 ? "good" : "warn"}`}>
                {status === 1 ? "Not paid" : (STATUS_LABEL[status] ?? status)}
              </span>
              {paid && inv && <span className="fine">{new Date(Number(inv.paidAt) * 1000).toLocaleString()}</span>}
            </div>
            <div className="receipt-amount">
              {formatUnits(inv!.amount, token.decimals)}{" "}
              <small style={{ fontSize: "0.4em", color: "var(--text-muted)" }}>{token.symbol}</small>
            </div>
            {status === 1 && (
              <p className="fine">
                This invoice is still open. It expires at {new Date(Number(inv!.expiry) * 1000).toLocaleString()}.{" "}
                <Link href={`/pay/${invoiceId}`}>Pay it</Link>
              </p>
            )}
            {status === 3 && <p className="fine">The merchant cancelled this invoice before it was paid.</p>}
            {status === 4 && <p className="fine">This invoice was paid and later refunded in full to the payer.</p>}
            <dl className="kv">
              <dt>Invoice id</dt>
              <dd>{invoiceId}</dd>
              <dt>Merchant</dt>
              <dd>
                {hasExplorer ? (
                  <a href={addressUrl(inv!.merchant)} target="_blank" rel="noreferrer">{inv!.merchant}</a>
                ) : (
                  inv!.merchant
                )}
              </dd>
              {paid && (
                <>
                  <dt>Payer</dt>
                  <dd>
                    {hasExplorer ? (
                      <a href={addressUrl(inv!.paidBy)} target="_blank" rel="noreferrer">{inv!.paidBy}</a>
                    ) : (
                      inv!.paidBy
                    )}
                  </dd>
                  <dt>Paid at</dt>
                  <dd>{new Date(Number(inv!.paidAt) * 1000).toLocaleString()}</dd>
                </>
              )}
              <dt>Memo hash</dt>
              <dd>{inv!.memoHash}</dd>
              <dt>InvoicePay</dt>
              <dd>{invoicePayAddress}</dd>
              {shownTx && (
                <>
                  <dt>Transaction</dt>
                  <dd>
                    {hasExplorer ? (
                      <a href={txUrl(shownTx)} target="_blank" rel="noreferrer">{shownTx}</a>
                    ) : (
                      shownTx
                    )}
                  </dd>
                </>
              )}
              {txMatches && receipt.data && (
                <>
                  <dt>Block</dt>
                  <dd>{receipt.data.blockNumber.toString()}</dd>
                  <dt>Gas used</dt>
                  <dd>{receipt.data.gasUsed.toString()}</dd>
                  <dt>Submitted by</dt>
                  <dd>{receipt.data.from}</dd>
                </>
              )}
            </dl>
            {tx && foundTx && !txMatches && (
              <p className="fine">The transaction in this link isn&apos;t the payment for this invoice, so it isn&apos;t shown.</p>
            )}
            {txMatches && receipt.data && inv && receipt.data.from.toLowerCase() !== inv.paidBy.toLowerCase() && (
              <p className="fine">The payer didn&apos;t send this transaction: a relayer submitted the payer&apos;s signature (gasless mode).</p>
            )}
          </>
        )}
      </section>

      <p className="fine">
        This page trusts nothing but the chain: it calls <code>InvoicePay.invoiceOf(invoiceId)</code> and finds the{" "}
        <code>Paid</code> event. The amount was fixed by the merchant when the invoice was created, so a receipt can&apos;t be
        faked with a dust payment. <Link href="/invoices">Your invoices</Link>
      </p>
    </main>
  );
}
