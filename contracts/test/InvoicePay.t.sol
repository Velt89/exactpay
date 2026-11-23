// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoicePay} from "../src/InvoicePay.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract InvoicePayTest is Test {
    MockUSD8 internal token;
    InvoicePay internal invoices;

    address internal merchant = makeAddr("merchant");
    uint256 internal payerPk = 0xB0B;
    address internal payer;
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant INVOICE_ID = bytes32("invoice-0001");
    uint256 internal constant AMOUNT = 25_000000; // 25 tUSD8

    function setUp() public {
        token = new MockUSD8();
        invoices = new InvoicePay(token);
        payer = vm.addr(payerPk);
        token.mint(payer, 100_000000);
        token.mint(stranger, 100_000000);
        vm.warp(1_700_000_000);
    }

    function _create(address expectedPayer, uint64 expiry) internal {
        vm.prank(merchant);
        invoices.createInvoice(INVOICE_ID, AMOUNT, expiry, expectedPayer, bytes32("memo"));
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    // --- the flaw this contract exists to fix ---------------------------------

    function test_DustPaymentCannotMarkInvoicePaid() public {
        _create(address(0), _expiry());
        // There is no way to pay "a little": pay() takes no amount and pulls the full
        // invoice amount or nothing. A payer with insufficient balance/allowance reverts
        // and the invoice stays open.
        vm.prank(stranger);
        token.approve(address(invoices), 1); // dust allowance, like pay(orderId, 1)
        vm.prank(stranger);
        vm.expectRevert();
        invoices.pay(INVOICE_ID);
        assertFalse(invoices.isPaid(INVOICE_ID));
    }

    // --- standard rail ---------------------------------------------------------

    function test_PayPullsExactAmountToMerchant() public {
        _create(address(0), _expiry());
        vm.prank(payer);
        token.approve(address(invoices), AMOUNT);
        vm.prank(payer);
        invoices.pay(INVOICE_ID);

        assertEq(token.balanceOf(merchant), AMOUNT);
        assertTrue(invoices.isPaid(INVOICE_ID));
        InvoicePay.Invoice memory inv = invoices.invoiceOf(INVOICE_ID);
        assertEq(inv.paidBy, payer);
        assertEq(inv.paidAt, uint64(block.timestamp));
    }

    function test_CannotPayTwice() public {
        _create(address(0), _expiry());
        vm.startPrank(payer);
        token.approve(address(invoices), AMOUNT * 2);
        invoices.pay(INVOICE_ID);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceNotOpen.selector, INVOICE_ID));
        invoices.pay(INVOICE_ID);
        vm.stopPrank();
    }

    function test_ExpiredInvoiceCannotBePaid() public {
        _create(address(0), uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(payer);
        token.approve(address(invoices), AMOUNT);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceExpired.selector, INVOICE_ID));
        invoices.pay(INVOICE_ID);
    }

    function test_ExpectedPayerIsEnforced() public {
        _create(payer, _expiry());
        vm.prank(stranger);
        token.approve(address(invoices), AMOUNT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.WrongPayer.selector, INVOICE_ID, stranger));
        invoices.pay(INVOICE_ID);
    }

    function test_DuplicateInvoiceIdReverts() public {
        _create(address(0), _expiry());
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceExists.selector, INVOICE_ID));
        invoices.createInvoice(INVOICE_ID, AMOUNT, _expiry(), address(0), bytes32("memo"));
    }

    // --- gasless rail ------------------------------------------------------------

    function test_PayWithAuthorization() public {
        _create(address(0), _expiry());
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            payerPk,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: payer,
                to: address(invoices),
                value: AMOUNT,
                validAfter: 0,
                validBefore: validBefore,
                nonce: invoices.authorizationNonce(INVOICE_ID)
            })
        );
        // A relayer (stranger) submits; the payer never sends a transaction.
        vm.prank(stranger);
        invoices.payWithAuthorization(INVOICE_ID, payer, 0, validBefore, v, r, s);
        assertEq(token.balanceOf(merchant), AMOUNT);
        assertTrue(invoices.isPaid(INVOICE_ID));
    }

    function test_AuthorizationForWrongAmountReverts() public {
        _create(address(0), _expiry());
        uint256 validBefore = block.timestamp + 1 hours;
        // Payer signs for 1 unit only — the token rejects it because the contract asks
        // receiveWithAuthorization for the full invoice amount, which the signature
        // does not cover.
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            payerPk,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: payer,
                to: address(invoices),
                value: 1,
                validAfter: 0,
                validBefore: validBefore,
                nonce: invoices.authorizationNonce(INVOICE_ID)
            })
        );
        vm.expectRevert();
        invoices.payWithAuthorization(INVOICE_ID, payer, 0, validBefore, v, r, s);
        assertFalse(invoices.isPaid(INVOICE_ID));
    }

    function test_AuthorizationCannotBeReplayedOnAnotherInvoice() public {
        _create(address(0), _expiry());
        bytes32 otherId = bytes32("invoice-0002");
        vm.prank(merchant);
        invoices.createInvoice(otherId, AMOUNT, _expiry(), address(0), bytes32("memo"));
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            payerPk,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: payer,
                to: address(invoices),
                value: AMOUNT,
                validAfter: 0,
                validBefore: validBefore,
                nonce: invoices.authorizationNonce(INVOICE_ID)
            })
        );
        // The signature is bound to INVOICE_ID's nonce; using it for otherId fails.
        vm.expectRevert();
        invoices.payWithAuthorization(otherId, payer, 0, validBefore, v, r, s);
    }

    // --- cancel & refund -----------------------------------------------------------

    function test_MerchantCanCancelOpenInvoice() public {
        _create(address(0), _expiry());
        vm.prank(merchant);
        invoices.cancelInvoice(INVOICE_ID);
        vm.prank(payer);
        token.approve(address(invoices), AMOUNT);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.InvoiceNotOpen.selector, INVOICE_ID));
        invoices.pay(INVOICE_ID);
    }

    function test_StrangerCannotCancel() public {
        _create(address(0), _expiry());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(InvoicePay.NotMerchant.selector, INVOICE_ID, stranger));
        invoices.cancelInvoice(INVOICE_ID);
    }

    function test_MerchantCanRefundPaidInvoice() public {
        _create(address(0), _expiry());
        vm.startPrank(payer);
        token.approve(address(invoices), AMOUNT);
        invoices.pay(INVOICE_ID);
        vm.stopPrank();

        uint256 payerBefore = token.balanceOf(payer);
        vm.startPrank(merchant);
        token.approve(address(invoices), AMOUNT);
        invoices.refundInvoice(INVOICE_ID);
        vm.stopPrank();

        assertEq(token.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(uint256(invoices.invoiceOf(INVOICE_ID).status), uint256(InvoicePay.Status.Refunded));
    }
}
