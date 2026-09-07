// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A registry that can hold subnames. ENSv2 passes these around by
///         interface, so a registry may itself be the subregistry of a name.
interface IRegistry {}

/**
 * @notice The slice of ENSv2's PermissionedRegistry this project uses.
 *
 * Written out rather than pulled in as a dependency, because compiling the
 * whole of `ensdomains/contracts-v2` to call four functions is a large amount
 * of build for no extra certainty — the signatures are checked against the
 * deployed contract in test/AgentNames.t.sol, on a fork, which is a stronger
 * guarantee than a matching source tree anyway.
 *
 * Selectors verified against
 * contracts/src/registry/interfaces/IStandardRegistry.sol at `main`.
 */
interface IPermissionedRegistry {
    enum Status {
        AVAILABLE,
        RESERVED,
        REGISTERED
    }

    struct State {
        Status status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    /// @notice Issue a subname. `roleBitmap` is what the holder may then do
    ///         with it, which is where an agent's permissions live.
    function register(
        string calldata label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function setResolver(uint256 anyId, address resolver) external;
    function setSubregistry(uint256 anyId, IRegistry registry) external;
    function getExpiry(uint256 anyId) external view returns (uint64);
    function getState(uint256 anyId) external view returns (State memory);
    function latestOwnerOf(uint256 tokenId) external view returns (address);

    /// @notice Enhanced Access Control. Roles are reversible and scoped to a
    ///         single name, which is the difference from ENSv1's one-way
    ///         fuses and the reason an agent's authority can be taken back.
    function grantRoles(uint256 anyId, uint256 roleBitmap, address account)
        external
        returns (bool);
    function revokeRoles(uint256 anyId, uint256 roleBitmap, address account)
        external
        returns (bool);
    function hasRoles(uint256 anyId, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}
