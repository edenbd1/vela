// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {IPermissionedRegistry} from "../src/IENSv2.sol";

/**
 * @notice Does the interface this project was written against match what is
 *         actually deployed?
 *
 * The addresses came out of documentation, and documentation is a claim. This
 * forks Sepolia and calls the real contract, which is the only way to know —
 * a project that ships against hand-copied selectors and finds out on demo
 * day has learned nothing from the rest of this repository.
 *
 *   forge test --fork-url https://ethereum-sepolia-rpc.publicnode.com -vv
 */
contract AgentNamesTest is Test {
    /// ENSv2 ETHRegistry on Sepolia — a PermissionedRegistry for the .eth namespace.
    IPermissionedRegistry constant ETH_REGISTRY =
        IPermissionedRegistry(0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2);

    function test_registryIsDeployed() public view {
        uint256 size;
        address a = address(ETH_REGISTRY);
        assembly {
            size := extcodesize(a)
        }
        assertGt(size, 0, "no code at the documented ETHRegistry address");
        console.log("ETHRegistry bytecode size:", size);
    }

    /// @notice A name nobody has taken should read as AVAILABLE.
    ///         This is the call that proves the ABI, not the address.
    function test_stateOfAnUnusedLabel() public view {
        uint256 labelhash = uint256(keccak256("vela-agent-fleet-probe-9f3a"));
        IPermissionedRegistry.State memory s = ETH_REGISTRY.getState(labelhash);
        console.log("status:", uint256(s.status));
        console.log("expiry:", s.expiry);
        assertEq(uint256(s.status), uint256(IPermissionedRegistry.Status.AVAILABLE));
    }

    /// @notice Enhanced Access Control answers for an account holding nothing.
    ///         The point is that the selector exists and the call returns,
    ///         which is what a later grantRoles depends on.
    function test_rolesOnAnUnusedLabel() public view {
        uint256 labelhash = uint256(keccak256("vela-agent-fleet-probe-9f3a"));
        bool held = ETH_REGISTRY.hasRoles(labelhash, type(uint256).max, address(this));
        assertFalse(held, "a fresh label should grant nobody anything");
    }
}
