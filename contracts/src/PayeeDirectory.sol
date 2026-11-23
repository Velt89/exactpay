// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayeeDirectory
/// @notice Confirmation of Payee for Aevum: a public name-to-address directory that a payer
///         checks before signing, so "pay 0x7f3a..." becomes "pay Baiwor Bakery (0x7f3a...)".
/// @dev QDay's ERC-8004 registry is not open for this challenge yet, so — as the starter kit
///      docs suggest — the mapping lives in our own contract. Names are unique, one name per
///      address, first come first served. The app lowercases names before registering, so the
///      on-chain key is the hash of the exact (lowercase) name string.
///      A listing is a claim, not a verification: the UI must always show the address next to
///      the name and warn that a similar-looking name is not the same payee.
contract PayeeDirectory {
    mapping(address account => string name) private _nameOf;
    mapping(bytes32 nameKey => address account) private _addressOf;

    event PayeeRegistered(address indexed account, string name);
    event PayeeReleased(address indexed account, string name);

    error NameTaken(string name);
    error AlreadyRegistered(address account);
    error NotRegistered(address account);
    error EmptyName();

    /// @notice Claim `name` for the caller. One name per address; release first to change it.
    function register(string calldata name) external {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(_nameOf[msg.sender]).length != 0) revert AlreadyRegistered(msg.sender);
        bytes32 key = nameKey(name);
        if (_addressOf[key] != address(0)) revert NameTaken(name);
        _nameOf[msg.sender] = name;
        _addressOf[key] = msg.sender;
        emit PayeeRegistered(msg.sender, name);
    }

    /// @notice Give up the caller's name, freeing it for someone else.
    function release() external {
        string memory name = _nameOf[msg.sender];
        if (bytes(name).length == 0) revert NotRegistered(msg.sender);
        delete _addressOf[nameKey(name)];
        delete _nameOf[msg.sender];
        emit PayeeReleased(msg.sender, name);
    }

    /// @notice The registered name for `account`, or "" if it has none.
    function nameOf(address account) external view returns (string memory) {
        return _nameOf[account];
    }

    /// @notice The address that claimed `name`, or the zero address if it is unclaimed.
    function addressOf(string calldata name) external view returns (address) {
        return _addressOf[nameKey(name)];
    }

    function nameKey(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }
}
