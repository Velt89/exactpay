import { parseAbi, type Address } from "viem";

/** tUSD8 on Aevum testnet: a USDC-style token (FiatTokenV2) with 6 decimals, EIP-2612 and EIP-3009. */
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;

/** EIP-712 domain of tUSD8. MockUSD8 (local) uses the same name and version. */
export function tusd8Domain(chainId: number, verifyingContract: Address) {
  return { name: "tUSD8", version: "2", chainId, verifyingContract } as const;
}

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** ABI of contracts/src/InvoicePay.sol. Status: 0 None, 1 Open, 2 Paid, 3 Cancelled, 4 Refunded. */
export const invoicePayAbi = parseAbi([
  "function token() view returns (address)",
  "function createInvoice(bytes32 invoiceId, uint256 amount, uint64 expiry, address expectedPayer, bytes32 memoHash)",
  "function pay(bytes32 invoiceId)",
  "function payWithAuthorization(bytes32 invoiceId, address from, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function cancelInvoice(bytes32 invoiceId)",
  "function refundInvoice(bytes32 invoiceId)",
  "function authorizationNonce(bytes32 invoiceId) view returns (bytes32)",
  "function invoiceIdFor(address merchant, bytes32 ref) pure returns (bytes32)",
  "function invoiceOf(bytes32 invoiceId) view returns ((address merchant, address expectedPayer, address paidBy, uint256 amount, uint64 expiry, uint64 paidAt, bytes32 memoHash, uint8 status))",
  "function isPaid(bytes32 invoiceId) view returns (bool)",
  "event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiry, address expectedPayer)",
  "event Paid(bytes32 indexed invoiceId, address indexed payer, uint256 amount)",
  "event InvoiceCancelled(bytes32 indexed invoiceId)",
  "event InvoiceRefunded(bytes32 indexed invoiceId, address indexed payer, uint256 amount)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error InvoiceExists(bytes32 invoiceId)",
  "error InvoiceNotFound(bytes32 invoiceId)",
  "error InvoiceNotOpen(bytes32 invoiceId)",
  "error InvoiceExpired(bytes32 invoiceId)",
  "error WrongPayer(bytes32 invoiceId, address payer)",
  "error NotMerchant(bytes32 invoiceId, address caller)",
  "error InvoiceNotPaid(bytes32 invoiceId)",
]);

/** ABI of contracts/src/PayeeDirectory.sol. */
export const payeeDirectoryAbi = parseAbi([
  "function register(string name)",
  "function release()",
  "function nameOf(address account) view returns (string)",
  "function addressOf(string name) view returns (address)",
  "event PayeeRegistered(address indexed account, string name)",
  "event PayeeReleased(address indexed account, string name)",
  "error NameTaken(string name)",
  "error AlreadyRegistered(address account)",
  "error NotRegistered(address account)",
  "error EmptyName()",
]);

/** ABI of contracts/src/Checkout.sol. */
export const checkoutAbi = parseAbi([
  "function token() view returns (address)",
  "function merchant() view returns (address)",
  "function pay(bytes32 orderId, uint256 amount)",
  "function payWithAuthorization(bytes32 orderId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 orderId) view returns (bytes32)",
  "function isPaid(bytes32 orderId) view returns (bool)",
  "function paymentOf(bytes32 orderId) view returns ((address payer, uint64 paidAt, uint256 amount))",
  "event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)",
  "error AlreadyPaid(bytes32 orderId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
]);
