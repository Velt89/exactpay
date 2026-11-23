// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title InvoicePay
/// @notice Merchant-issued invoices paid in tUSD8 on Aevum, with the amount fixed on-chain.
/// @dev Why this exists: the starter kit's Checkout lets anyone pay ANY amount for an order
///      id, so `pay(orderId, 1)` marks an order paid for 0.000001 tUSD8 and the app has to
///      catch the shortfall off-chain (the kit docs warn about exactly this). Here the
///      merchant creates the invoice with its exact amount and expiry, and the payer never
///      supplies an amount at all — the contract pulls precisely `invoice.amount`, so a
///      dust payment cannot mark an invoice paid, an expired invoice cannot be paid late,
///      and a paid invoice cannot be paid twice.
///      Two rails, same as the kit:
///      1. `pay`: the payer approves this contract, then calls `pay` (payer pays gas).
///      2. `payWithAuthorization`: the payer signs an EIP-3009 message off-chain and anyone
///         (a relayer, the merchant) submits it. The payer needs no native gas.
///      The signed nonce is `authorizationNonce(invoiceId)`, binding the signature to this
///      one invoice so it cannot be replayed against another.
contract InvoicePay {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Cancelled,
        Refunded
    }

    struct Invoice {
        address merchant;
        address expectedPayer; // address(0) = anyone may pay
        address paidBy;
        uint256 amount;
        uint64 expiry;
        uint64 paidAt;
        bytes32 memoHash; // hash of the invoice memo / line items, kept off-chain
        Status status;
    }

    IERC20 public immutable token;

    mapping(bytes32 invoiceId => Invoice) private _invoices;

    event InvoiceCreated(
        bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiry, address expectedPayer
    );
    event Paid(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event InvoiceCancelled(bytes32 indexed invoiceId);
    event InvoiceRefunded(bytes32 indexed invoiceId, address indexed payer, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvoiceExists(bytes32 invoiceId);
    error InvoiceNotFound(bytes32 invoiceId);
    error InvoiceNotOpen(bytes32 invoiceId);
    error InvoiceExpired(bytes32 invoiceId);
    error WrongPayer(bytes32 invoiceId, address payer);
    error NotMerchant(bytes32 invoiceId, address caller);
    error InvoiceNotPaid(bytes32 invoiceId);

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Create an invoice. `invoiceId` must be unused; use an unguessable id
    ///         (for example `invoiceIdFor(merchant, orderRef)` with a random order ref).
    /// @param expectedPayer Optional: restrict payment to one address (0 = anyone).
    /// @param memoHash Hash of the off-chain memo (line items, terms) this invoice covers.
    function createInvoice(
        bytes32 invoiceId,
        uint256 amount,
        uint64 expiry,
        address expectedPayer,
        bytes32 memoHash
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (_invoices[invoiceId].status != Status.None) revert InvoiceExists(invoiceId);
        _invoices[invoiceId] = Invoice({
            merchant: msg.sender,
            expectedPayer: expectedPayer,
            paidBy: address(0),
            amount: amount,
            expiry: expiry,
            paidAt: 0,
            memoHash: memoHash,
            status: Status.Open
        });
        emit InvoiceCreated(invoiceId, msg.sender, amount, expiry, expectedPayer);
    }

    /// @notice Pay invoice `invoiceId` in full. Pulls exactly the invoice amount from the
    ///         caller (who must have approved this contract) straight to the merchant.
    function pay(bytes32 invoiceId) external {
        Invoice storage invoice = _openInvoice(invoiceId, msg.sender);
        _markPaid(invoiceId, invoice, msg.sender);
        token.safeTransferFrom(msg.sender, invoice.merchant, invoice.amount);
    }

    /// @notice Pay invoice `invoiceId` with an EIP-3009 `ReceiveWithAuthorization` signed by
    ///         `from`. The signed amount must equal the invoice amount and the signed nonce
    ///         must be `authorizationNonce(invoiceId)`; `to` must be this contract.
    function payWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Invoice storage invoice = _openInvoice(invoiceId, from);
        _markPaid(invoiceId, invoice, from);
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), invoice.amount, validAfter, validBefore, authorizationNonce(invoiceId), v, r, s
        );
        token.safeTransfer(invoice.merchant, invoice.amount);
    }

    /// @notice Cancel an unpaid invoice. Merchant only.
    function cancelInvoice(bytes32 invoiceId) external {
        Invoice storage invoice = _invoice(invoiceId);
        if (msg.sender != invoice.merchant) revert NotMerchant(invoiceId, msg.sender);
        if (invoice.status != Status.Open) revert InvoiceNotOpen(invoiceId);
        invoice.status = Status.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice Refund a paid invoice in full. Merchant only; the merchant must have approved
    ///         this contract to pull the amount back to the original payer.
    function refundInvoice(bytes32 invoiceId) external {
        Invoice storage invoice = _invoice(invoiceId);
        if (msg.sender != invoice.merchant) revert NotMerchant(invoiceId, msg.sender);
        if (invoice.status != Status.Paid) revert InvoiceNotPaid(invoiceId);
        invoice.status = Status.Refunded;
        token.safeTransferFrom(invoice.merchant, invoice.paidBy, invoice.amount);
        emit InvoiceRefunded(invoiceId, invoice.paidBy, invoice.amount);
    }

    /// @notice The EIP-3009 nonce a payer must sign to pay `invoiceId` through this contract.
    function authorizationNonce(bytes32 invoiceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), invoiceId));
    }

    /// @notice Derive a per-merchant invoice id from an off-chain reference (order number,
    ///         booking code...). Pair it with a random ref so ids stay unguessable.
    function invoiceIdFor(address merchant, bytes32 ref) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, ref));
    }

    function invoiceOf(bytes32 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function isPaid(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].status == Status.Paid;
    }

    function _invoice(bytes32 invoiceId) private view returns (Invoice storage invoice) {
        invoice = _invoices[invoiceId];
        if (invoice.status == Status.None) revert InvoiceNotFound(invoiceId);
    }

    function _openInvoice(bytes32 invoiceId, address payer) private view returns (Invoice storage invoice) {
        invoice = _invoice(invoiceId);
        if (invoice.status != Status.Open) revert InvoiceNotOpen(invoiceId);
        if (block.timestamp > invoice.expiry) revert InvoiceExpired(invoiceId);
        if (invoice.expectedPayer != address(0) && invoice.expectedPayer != payer) {
            revert WrongPayer(invoiceId, payer);
        }
    }

    function _markPaid(bytes32 invoiceId, Invoice storage invoice, address payer) private {
        invoice.status = Status.Paid;
        invoice.paidBy = payer;
        invoice.paidAt = uint64(block.timestamp);
        emit Paid(invoiceId, payer, invoice.amount);
    }
}
