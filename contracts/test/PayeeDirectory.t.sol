// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayeeDirectory} from "../src/PayeeDirectory.sol";

contract PayeeDirectoryTest is Test {
    PayeeDirectory internal directory;
    address internal bakery = makeAddr("bakery");
    address internal other = makeAddr("other");

    function setUp() public {
        directory = new PayeeDirectory();
    }

    function test_RegisterAndLookUpBothWays() public {
        vm.prank(bakery);
        directory.register("baiwor bakery");
        assertEq(directory.nameOf(bakery), "baiwor bakery");
        assertEq(directory.addressOf("baiwor bakery"), bakery);
    }

    function test_NameCannotBeTakenTwice() public {
        vm.prank(bakery);
        directory.register("baiwor bakery");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(PayeeDirectory.NameTaken.selector, "baiwor bakery"));
        directory.register("baiwor bakery");
    }

    function test_OneNamePerAddress() public {
        vm.prank(bakery);
        directory.register("baiwor bakery");
        vm.prank(bakery);
        vm.expectRevert(abi.encodeWithSelector(PayeeDirectory.AlreadyRegistered.selector, bakery));
        directory.register("baiwor cafe");
    }

    function test_ReleaseFreesTheName() public {
        vm.prank(bakery);
        directory.register("baiwor bakery");
        vm.prank(bakery);
        directory.release();
        assertEq(directory.nameOf(bakery), "");
        assertEq(directory.addressOf("baiwor bakery"), address(0));
        vm.prank(other);
        directory.register("baiwor bakery");
        assertEq(directory.addressOf("baiwor bakery"), other);
    }

    function test_EmptyNameReverts() public {
        vm.prank(bakery);
        vm.expectRevert(PayeeDirectory.EmptyName.selector);
        directory.register("");
    }
}
