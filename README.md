# ExactPay — invoices that can't be short-paid

**Exact-amount invoice payments with Confirmation of Payee, on QDay Aevum testnet (chain 44005), settled in tUSD8.**

Built for the [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday) (QDay), solo, on top of the MIT-licensed [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (its full documentation is kept in [STARTER-KIT.md](STARTER-KIT.md)).

- **Live contracts (Aevum testnet):**
  - `InvoicePay` — [0xc6C7aa266eE2Bad2f1d12D09Ebef706bAf934702](https://explorer-test.qday.info/address/0xc6C7aa266eE2Bad2f1d12D09Ebef706bAf934702)
  - `PayeeDirectory` — [0x5c17A736dB5DE648d5E2901038FCDd75Ba5121f2](https://explorer-test.qday.info/address/0x5c17A736dB5DE648d5E2901038FCDd75Ba5121f2)
  - Deployed at block 3,802,447.
- **Live app:** [exactpay-velt89.vercel.app](https://exactpay-velt89.vercel.app) — the deployed web app on Vercel (Aevum testnet; gasless relay enabled).
- **Demo video:** [Watch on YouTube](https://www.youtube.com/watch?v=7TG1ZM22onQ) (1:18) — a narrated walkthrough of the live app and the on-chain payments below.

---

## The problem

The starter kit's `Checkout` — like most minimal payment contracts — lets anyone pay **any** amount for an order id. The kit's own documentation warns about it: `pay(orderId, 1)` marks an order as paid for 0.000001 tUSD8, and the application has to catch the shortfall off-chain, forever, on every read path. One missed check and a merchant ships against a dust payment. The contract also has no idea *who* an invoice is for, when it expires, or who the payer believes they are paying — the classic setup for the misdirected-payment fraud that Confirmation of Payee schemes exist to prevent in traditional banking.

## The solution

Two contracts move those guarantees on-chain:

### `InvoicePay` — the amount is fixed at creation, not at payment

The merchant creates the invoice: exact amount, expiry, an optional designated payer, and a hash of the off-chain memo. The payer never supplies an amount — `pay(invoiceId)` pulls exactly `invoice.amount`, so:

- a dust payment **cannot** mark an invoice paid (there is no amount parameter to abuse);
- an expired invoice cannot be paid late, and a paid invoice cannot be paid twice;
- an invoice restricted to one payer cannot be paid by anyone else;
- the merchant can cancel an unpaid invoice, and refund a paid one in full to the original payer.

Both payment rails from the kit are kept:

1. **Standard** — approve the exact amount, then `pay` (payer pays gas).
2. **Gasless** — the payer signs an EIP-3009 `ReceiveWithAuthorization` off-chain and anyone (the app's relayer, the merchant) submits it. The signed nonce is `keccak256(contract, invoiceId)`, binding the signature to this one invoice, and `receiveWithAuthorization` means only `InvoicePay` can pull the funds. The payer needs no tQDAY at all.

### `PayeeDirectory` — Confirmation of Payee

QDay's ERC-8004 registry is not open for this challenge yet, so — as the starter kit docs suggest — the name-to-address mapping lives in our own contract. A payee claims a unique human name (`baiwor bakery` → `0xb5C5…`). Before signing, the payer sees **"You are paying *baiwor bakery* (0xb5C5…)"** and must explicitly confirm the name and address. If the payee has no registered name, the app warns the payer to verify the address out-of-band. A listing is a claim, not a verification — the UI says so, and always shows the address next to the name.

## Live on Aevum testnet

Real transactions from the demo flow (merchant = `baiwor bakery`):

| Step | Transaction |
| --- | --- |
| Merchant registers the name "baiwor bakery" | [0xfd53…66cb](https://explorer-test.qday.info/tx/0xfd53f53a8fd63fd469bca595bf1ef40e9c9f4909614a71e883304877621c66cb) |
| Invoice #1 created — 1.25 tUSD8, payer-restricted | [0x1a42…76f2](https://explorer-test.qday.info/tx/0x1a4237e5399a8707d677246e147e1ae2b4c81fe27e1575b8b266e4f92f6476f2) |
| Invoice #1 paid (standard rail) | [0x8193…7e8b](https://explorer-test.qday.info/tx/0x8193821461ad0740d628d694fbe82ba6b6ce0dc3ce2fd1040dfe429033a77e8b) |
| Invoice #2 created — 1.50 tUSD8 | [0x39e1…83c](https://explorer-test.qday.info/tx/0x39e130f17bcd5fe2441c29fe3be52279b4268588e06f1787e667eb71a226b83c) |
| Invoice #2 paid (gasless, relayer-submitted) | [0xdda2…2be](https://explorer-test.qday.info/tx/0xdda24a36888ae6c660e3f80fb9fb39e555bfa8d72f650dd4c4cbfa48e1eff2be) |

## Architecture

```
contracts/src/
  InvoicePay.sol       invoices with on-chain amounts, expiry, payer restriction, cancel/refund
  PayeeDirectory.sol   Confirmation-of-Payee name directory
  Checkout.sol         the starter kit's checkout, kept for reference and its test-suite
  mocks/MockUSD8.sol   local tUSD8 stand-in (same EIP-712 domain + EIP-3009)
web/                   Next.js app
  src/app/invoices     merchant dashboard: issue invoices, cancel, refund
  src/app/pay/[id]     payer flow: Confirmation of Payee, then standard or gasless payment
  src/app/directory    register / look up payee names
  src/app/receipts     on-chain receipt for a paid invoice
  src/app/activity     live Paid-event feed (chunked log reads, Aevum's 1,000-block limit)
  src/app/api/relay    gasless relayer — reads the amount from the chain, never from the request
packages/aevum/        chain config, ABIs, EIP-3009 + chunked-log helpers (from the kit)
examples/              CLI examples from the kit (setup check, gasless pay, event reader)
```

The relayer keeps every rail the kit shipped (rate limits, daily cap, in-flight claims, simulation before sending, anvil-key refusal on real networks) and adds one of its own: it verifies on-chain that the invoice is open, unexpired, and payable by the signer before spending any gas.

## Run it

Prerequisites: Node 22+, pnpm, Foundry.

```bash
git clone <this repo>
cd exactpay
make install && make check        # contracts: build, Shanghai check, unit + fork tests
```

(The Solidity libraries are vendored under `contracts/lib` with their own LICENSE files, so no submodule step is needed.)

Against a **local fork** of Aevum (no funds needed):

```bash
make fork                          # terminal 1
cd contracts && forge script script/DeployOurs.s.sol --rpc-url http://127.0.0.1:8555 --broadcast --unlocked --sender <anvil account>
make deal TO=<your address>        # 100 tUSD8 + 10 tQDAY on the fork
# copy web/.env.example to web/.env.local, set NEXT_PUBLIC_NETWORKS=fork,aevum and the
# NEXT_PUBLIC_INVOICEPAY_FORK / NEXT_PUBLIC_DIRECTORY_FORK addresses from the deploy
make dev
```

Against **Aevum testnet**: fund a fresh test wallet from the Discord faucet (`/faucet` in the QDay Discord — the web faucet requires a mainnet balance), deploy with `forge script script/DeployOurs.s.sol --rpc-url https://rpc-test.qday.info --broadcast --legacy --private-key <test key>`, and set the `*_AEVUM` variables plus `RELAYER_PRIVATE_KEY` (a test wallet holding a little tQDAY) in `web/.env.local`.

**Docker (alternative):** a `Dockerfile` at the repo root builds the web app preconfigured for the live Aevum deployment — `docker build -t exactpay . && docker run -p 3000:3000 --env-file web/.env.local exactpay`. The relayer key stays a runtime env variable and is never baked into the image.

## Tests

- Unit: 17 tests for `InvoicePay` + `PayeeDirectory`, including the headline property — *a dust payment cannot mark an invoice paid* — plus expiry, double-pay, payer restriction, cancel/refund, signature replay across invoices, and wrong-amount authorizations.
- Fork: both rails and the directory run against the **real tUSD8** on a local fork of Aevum (`make test-fork`).
- `make check` also verifies the bytecode is Shanghai-safe (Aevum has no Cancun opcodes).

## Safety notes

- Exact-amount approvals only; the contracts never ask for unlimited allowances.
- Testnet only, test tokens only. Never commit a private key: every `.env*` file is git-ignored, and the deployer/relayer keys for the live demo are throwaway test wallets.
- Contract verification on the Aevum explorer is not available yet, so the deployed addresses above correspond to the source in this repository at the submission commit.

## License and credit

MIT (see [LICENSE](LICENSE)). Built on the [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) by QDay / PQA Labs (MIT) — chain plumbing, the checkout reference implementation, the relayer rails, and the web shell are theirs; `InvoicePay`, `PayeeDirectory`, and the invoice/payee application layer are this project's. Third-party notices: [NOTICE.md](NOTICE.md).
