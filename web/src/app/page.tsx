"use client";

import { links, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import Link from "next/link";
import { formatEther, formatUnits } from "viem";
import { useAccount, useBalance, useBytecode, useReadContract } from "wagmi";
import { erc20Abi } from "@aevum-kit/aevum";
import { CheckIcon, CrossIcon, WarnIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { short } from "@/lib/order";

type Status = "ok" | "warn" | "bad" | "idle";
interface Check {
  title: string;
  status: Status;
  value: string;
  detail: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

const DISCORD_FAUCET = "Verify in the QDay Discord, then run /faucet <your address> (1 tQDAY + 5 tUSD8, once).";

// Shown on a fork, where balances surprise people: they are the real testnet balances.
const FORK_COPY = "Copied from Aevum testnet when the fork started. Spending it here doesn't touch the real testnet.";

export default function HomePage() {
  const { net, select } = useNetwork();
  const appChain = net.chain;
  const chainMode = net.key;
  const invoicePayAddress = net.invoicePay;
  const directoryAddress = net.directory;
  const { address, isConnected, chainId, connector } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const gas = useBalance({ address, chainId: appChain.id, query: { enabled: onChain } });
  const tokenBal = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });
  const invoicePayCode = useBytecode({ address: invoicePayAddress, chainId: appChain.id, query: { enabled: Boolean(invoicePayAddress) } });
  const directoryCode = useBytecode({ address: directoryAddress, chainId: appChain.id, query: { enabled: Boolean(directoryAddress) } });

  const contractCheck = (title: string, addr: string | undefined, code: typeof invoicePayCode, envVar: string, makeCmd: string): Check =>
    !addr
      ? { title, status: "warn", value: "not set", detail: `Deploy it with \`${makeCmd}\`, then set ${envVar} in web/.env.local.` }
      : code.isLoading
        ? { title, status: "idle", value: short(addr), detail: "Looking it up…" }
        : code.data && code.data !== "0x"
          ? { title, status: "ok", value: short(addr), detail: "Deployed and reachable." }
          : { title, status: "bad", value: short(addr), detail: `No contract at this address on ${appChain.name}. Check the address in web/.env.local.` };

  const gasValue = gas.data?.value;
  const tokenValue = tokenBal.data;

  const checks: Check[] = [
    isConnected
      ? { title: "Wallet connected", status: "ok", value: short(address ?? ""), detail: `${connector?.name ?? "Wallet"} is connected.` }
      : { title: "Wallet connected", status: "bad", value: "not connected", detail: "Connect MetaMask, Rabby or any browser wallet with the button at the top right." },
    !isConnected
      ? { title: "Network", status: "idle", value: "—", detail: `Needs ${appChain.name} (${appChain.id}).` }
      : onChain
        ? { title: "Network", status: "ok", value: `chain ${appChain.id}`, detail: `Connected to ${appChain.rpcUrls.default.http[0]}.` }
        : {
            title: "Network",
            status: "bad",
            value: `chain ${chainId}`,
            detail: `Switch to ${appChain.name} (${appChain.id}). Your wallet will offer to add it.`,
            action: { label: "Switch network", onClick: () => select(net.key) },
          },
    !onChain || gasValue === undefined
      ? { title: `Gas (${appChain.nativeCurrency.symbol})`, status: "idle", value: "—", detail: "Pays for transactions. Gasless payment doesn't need it." }
      : gasValue > 0n
        ? { title: `Gas (${appChain.nativeCurrency.symbol})`, status: "ok", value: `${Number(formatEther(gasValue)).toFixed(4)} ${appChain.nativeCurrency.symbol}`, detail: chainMode === "fork" ? FORK_COPY : "1 tQDAY covers hundreds of contract calls at 1 gwei." }
        : chainMode === "aevum"
          ? { title: "Gas (tQDAY)", status: "warn", value: "0 tQDAY", detail: DISCORD_FAUCET, action: { label: "Open web faucet", href: links.faucetWeb } }
          : { title: "Gas", status: "warn", value: "0", detail: chainMode === "fork" ? "Give yourself tQDAY and tUSD8 with `make deal TO=<address>`." : "Import one of anvil's default accounts into your wallet (local chain only)." },
    !onChain || tokenValue === undefined
      ? { title: `${token.symbol} balance`, status: "idle", value: "—", detail: "The stablecoin ExactPay uses (6 decimals)." }
      : tokenValue > 0n
        ? { title: `${token.symbol} balance`, status: "ok", value: `${formatUnits(tokenValue, token.decimals)} ${token.symbol}`, detail: chainMode === "fork" ? "Ready to pay. Also copied from Aevum testnet." : "Ready to pay." }
        : chainMode === "aevum"
          ? { title: "tUSD8 balance", status: "warn", value: "0 tUSD8", detail: DISCORD_FAUCET }
          : { title: `${token.symbol} balance`, status: "warn", value: "0", detail: chainMode === "fork" ? "On a fork, give yourself tUSD8 with `make deal TO=<address>`." : "MockUSD8 lets anyone mint: `make mint TO=<address>`." },
    contractCheck("InvoicePay contract", invoicePayAddress, invoicePayCode, `NEXT_PUBLIC_INVOICEPAY_${net.key.toUpperCase()}`, "make deploy-aevum"),
    contractCheck("PayeeDirectory contract", directoryAddress, directoryCode, `NEXT_PUBLIC_DIRECTORY_${net.key.toUpperCase()}`, "make deploy-aevum"),
  ];

  const passed = checks.filter((c) => c.status === "ok").length;
  const left = checks.length - passed;

  return (
    <main className="shell">
      <section className="page-head">
        <div>
          <p className="eyebrow">ExactPay · Aevum Builder Challenge #1</p>
          <h1>Invoices that can only be paid exactly</h1>
          <p className="lede">
            ExactPay is merchant invoicing in tUSD8 on QDay Aevum testnet. The merchant fixes the amount on-chain when the invoice
            is created, and the payer confirms <em>who</em> they are paying — by registered name, not just by address — before
            signing.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="btn big" href="/invoices">
            Create an invoice
          </Link>
          <Link className="btn big secondary" href="/directory">
            Register your payee name
          </Link>
        </div>
      </section>

      <section className="grid-2" aria-label="About ExactPay">
        <div className="card">
          <h2>The problem it fixes</h2>
          <p className="sub">
            The starter kit&apos;s <code>Checkout</code> lets anyone pay <strong>any</strong> amount for an order id:{" "}
            <code>pay(orderId, 1)</code> marks an order &ldquo;paid&rdquo; for 0.000001 tUSD8, and every app has to catch the
            shortfall off-chain (the kit docs warn about exactly this). One missed check and a merchant ships against a dust
            payment.
          </p>
          <ul>
            <li>The payer never supplies an amount — the contract pulls precisely <code>invoice.amount</code>.</li>
            <li>Expired invoices can&apos;t be paid late, paid invoices can&apos;t be paid twice, cancelled ones can&apos;t be paid at all.</li>
            <li>An invoice can be addressed to one expected payer; everyone else is rejected on-chain.</li>
          </ul>
        </div>

        <div className="card">
          <h2>How it works</h2>
          <ol className="steps">
            <li className="step">
              <div className="step-dot">1</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title" style={{ color: "var(--text)" }}>Merchant issues the invoice</span>
                </div>
                <p className="step-who">
                  <Link href="/invoices">Invoices</Link> — amount, expiry and an optional expected payer are written to InvoicePay.
                  Share the /pay link.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="step-dot">2</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title" style={{ color: "var(--text)" }}>Payer confirms the payee</span>
                </div>
                <p className="step-who">
                  The pay page looks the merchant up in the <Link href="/directory">PayeeDirectory</Link>: &ldquo;You are paying{" "}
                  <strong>Baiwor Bakery</strong>&rdquo;, full address shown, tick to confirm. No name registered? A warning tells the
                  payer to verify the address out-of-band.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="step-dot">3</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title" style={{ color: "var(--text)" }}>Pay — Standard or Gasless</span>
                </div>
                <p className="step-who">
                  Approve + pay, or sign an EIP-3009 authorization and let the relayer submit it (the relayer reads the amount from
                  the invoice itself). The <code>Paid</code> event is the receipt.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section className="page-head" style={{ alignItems: "center" }}>
        <div>
          <p className="eyebrow">Setup</p>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em" }}>
            Is your setup ready for Aevum?
          </h2>
          <p className="lede" style={{ fontSize: 15 }}>
            Add Aevum testnet (chain 44005) to your wallet, claim test tokens from the{" "}
            <a href={links.faucetWeb} target="_blank" rel="noreferrer">
              web faucet
            </a>{" "}
            or with <code>/faucet</code> in the QDay Discord ({DISCORD_FAUCET}), then check the list.
          </p>
        </div>
        <div className="score" aria-live="polite">
          <span className="score-num">
            {passed}
            <small> / {checks.length}</small>
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: left ? "var(--warn)" : "var(--good)" }}>
            {left ? `${left} item${left > 1 ? "s" : ""} to fix` : "Ready to build"}
          </span>
        </div>
      </section>

      <section className="grid-2" aria-label="Setup checks">
        <div className="card flush">
          {checks.map((c) => (
            <div className="check" key={c.title}>
              <div className={`chip ${c.status}`}>
                {c.status === "ok" ? <CheckIcon /> : c.status === "bad" ? <CrossIcon /> : c.status === "warn" ? <WarnIcon /> : null}
              </div>
              <div className="check-body">
                <div className="check-top">
                  <span className="check-title">{c.title}</span>
                  <span className={`check-value ${c.status === "warn" ? "warn" : c.status === "bad" ? "bad" : ""}`}>{c.value}</span>
                </div>
                <p className="check-detail">{c.detail}</p>
                {c.action && (
                  <div className="check-action">
                    {c.action.href ? (
                      <a className="btn small" href={c.action.href} target="_blank" rel="noreferrer">
                        {c.action.label}
                      </a>
                    ) : (
                      <button type="button" className="btn small" onClick={c.action.onClick}>
                        {c.action.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="stack">
          <div className="card">
            <h2>Network details</h2>
            <p className="sub">Contracts on the network this app is currently set to ({net.label}).</p>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{appChain.name}</dd>
              <dt>Chain ID</dt>
              <dd>{appChain.id}</dd>
              <dt>RPC</dt>
              <dd>{appChain.rpcUrls.default.http[0]}</dd>
              <dt>Explorer</dt>
              <dd>{net.hasExplorer ? links.explorer.replace("https://", "") : "none (local chain)"}</dd>
              <dt>tUSD8</dt>
              <dd>{chainMode === "local" ? "MockUSD8 (local)" : `${short(TUSD8_ADDRESS)} · 6 dec`}</dd>
              <dt>InvoicePay</dt>
              <dd>{invoicePayAddress ?? "not set"}</dd>
              <dt>PayeeDirectory</dt>
              <dd>{directoryAddress ?? "not set"}</dd>
              <dt>EVM</dt>
              <dd>shanghai</dd>
            </dl>
            {isConnected && !onChain && (
              <button type="button" className="btn secondary block" style={{ marginTop: 16 }} onClick={() => select(net.key)}>
                Add {appChain.name} to wallet
              </button>
            )}
          </div>

          <div className="card info">
            <h2>Faucets</h2>
            <ul>
              <li>
                Web:{" "}
                <a href={links.faucetWeb} target="_blank" rel="noreferrer">
                  faucet.qday.info
                </a>{" "}
                — paste your wallet address for tQDAY and tUSD8.
              </li>
              <li>Discord: {DISCORD_FAUCET}</li>
              <li>Gasless payment needs no tQDAY at all — the relayer pays the gas.</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
