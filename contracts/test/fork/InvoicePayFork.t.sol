// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoicePay} from "../../src/InvoicePay.sol";
import {PayeeDirectory} from "../../src/PayeeDirectory.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs InvoicePay + PayeeDirectory against the REAL tUSD8 on a local fork of
///         Aevum testnet. Run with: make test-fork
contract InvoicePayForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    address internal merchant = makeAddr("merchant");
    bytes32 internal constant INVOICE_ID = bytes32("fork-invoice-0001");
    uint256 internal constant AMOUNT = 25e6; // 25 tUSD8

    function test_realTusd8_invoicePay_standardRail() public {
        InvoicePay invoices = new InvoicePay(TUSD8);
        address buyer = makeAddr("buyer");
        deal(address(TUSD8), buyer, 100e6);

        vm.prank(merchant);
        invoices.createInvoice(INVOICE_ID, AMOUNT, uint64(block.timestamp + 1 days), address(0), bytes32("memo"));

        vm.startPrank(buyer);
        TUSD8.approve(address(invoices), AMOUNT);
        invoices.pay(INVOICE_ID);
        vm.stopPrank();

        assertEq(TUSD8.balanceOf(merchant), AMOUNT);
        assertTrue(invoices.isPaid(INVOICE_ID));
    }

    function test_realTusd8_invoicePay_gaslessRail() public {
        InvoicePay invoices = new InvoicePay(TUSD8);
        (address buyer, uint256 key) = makeAddrAndKey("buyer");
        deal(address(TUSD8), buyer, 100e6);

        vm.prank(merchant);
        invoices.createInvoice(INVOICE_ID, AMOUNT, uint64(block.timestamp + 1 days), address(0), bytes32("memo"));

        uint256 deadline = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(invoices),
            value: AMOUNT,
            validAfter: 0,
            validBefore: deadline,
            nonce: invoices.authorizationNonce(INVOICE_ID)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, key, TUSD8.DOMAIN_SEPARATOR(), a);

        vm.prank(makeAddr("relayer"));
        invoices.payWithAuthorization(INVOICE_ID, buyer, 0, deadline, v, r, s);

        assertEq(TUSD8.balanceOf(merchant), AMOUNT);
        assertEq(TUSD8.balanceOf(buyer), 100e6 - AMOUNT);
        assertTrue(TUSD8.authorizationState(buyer, invoices.authorizationNonce(INVOICE_ID)));
    }

    function test_realTusd8_payeeDirectory() public {
        PayeeDirectory directory = new PayeeDirectory();
        vm.prank(merchant);
        directory.register("baiwor bakery");
        assertEq(directory.addressOf("baiwor bakery"), merchant);
        assertEq(directory.nameOf(merchant), "baiwor bakery");
    }
}
