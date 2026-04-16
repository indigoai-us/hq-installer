/// Acceptance tests for US-005: keychain.rs — secure token storage.
///
/// Each test uses a UUID-based account name so parallel runs never collide.
/// Teardown always deletes the test entry (idempotent delete makes this safe).

#[cfg(test)]
mod keychain_tests {
    use hq_installer_lib::commands::keychain::{
        keychain_delete_impl, keychain_get_impl, keychain_set_impl,
    };
    use serial_test::serial;
    use uuid::Uuid;

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: unique account name so tests don't share state
    // ─────────────────────────────────────────────────────────────────────────

    fn unique_account() -> String {
        format!("test-{}", Uuid::new_v4())
    }

    const SUB_SERVICE: &str = "test";

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: set + get roundtrip
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_set_and_get_roundtrip() {
        let account = unique_account();
        let secret = "super-secret-value-001";

        let set_result = keychain_set_impl(SUB_SERVICE, &account, secret);
        assert!(
            set_result.is_ok(),
            "keychain_set should succeed, got: {:?}",
            set_result
        );

        let get_result = keychain_get_impl(SUB_SERVICE, &account);
        assert!(
            get_result.is_ok(),
            "keychain_get should succeed, got: {:?}",
            get_result
        );
        assert_eq!(
            get_result.unwrap(),
            Some(secret.to_string()),
            "retrieved secret should match stored secret"
        );

        // Teardown
        let _ = keychain_delete_impl(SUB_SERVICE, &account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: get on absent key returns Ok(None)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_get_absent_key_returns_none() {
        let account = unique_account();

        // Ensure it's absent first
        let _ = keychain_delete_impl(SUB_SERVICE, &account);

        let result = keychain_get_impl(SUB_SERVICE, &account);
        assert!(
            result.is_ok(),
            "keychain_get on absent key should return Ok, got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            None,
            "keychain_get on absent key should return None"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: delete + get returns None
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_delete_then_get_returns_none() {
        let account = unique_account();
        let secret = "will-be-deleted";

        // Set, then delete
        keychain_set_impl(SUB_SERVICE, &account, secret)
            .expect("set should succeed");
        keychain_delete_impl(SUB_SERVICE, &account)
            .expect("delete should succeed");

        let result = keychain_get_impl(SUB_SERVICE, &account);
        assert!(
            result.is_ok(),
            "get after delete should return Ok, got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            None,
            "get after delete should return None"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: delete is idempotent — deleting a non-existent key returns Ok
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_delete_nonexistent_is_idempotent() {
        let account = unique_account();

        // Make sure it truly doesn't exist
        let _ = keychain_delete_impl(SUB_SERVICE, &account);

        // Delete again — must not error
        let result = keychain_delete_impl(SUB_SERVICE, &account);
        assert!(
            result.is_ok(),
            "deleting a non-existent key should return Ok, got: {:?}",
            result
        );

        // Third call for good measure
        let result2 = keychain_delete_impl(SUB_SERVICE, &account);
        assert!(
            result2.is_ok(),
            "repeated delete of non-existent key should return Ok, got: {:?}",
            result2
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: set overwrites an existing value
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_set_overwrites_existing() {
        let account = unique_account();
        let first = "first-value";
        let second = "second-value";

        keychain_set_impl(SUB_SERVICE, &account, first)
            .expect("first set should succeed");
        keychain_set_impl(SUB_SERVICE, &account, second)
            .expect("second set (overwrite) should succeed");

        let result = keychain_get_impl(SUB_SERVICE, &account);
        assert!(result.is_ok(), "get after overwrite should succeed");
        assert_eq!(
            result.unwrap(),
            Some(second.to_string()),
            "get should return the overwritten value"
        );

        // Teardown
        let _ = keychain_delete_impl(SUB_SERVICE, &account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: service prefix is applied — different sub-services don't collide
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn keychain_different_services_are_isolated() {
        let account = unique_account();
        let service_a = "service-a";
        let service_b = "service-b";

        keychain_set_impl(service_a, &account, "value-a")
            .expect("set on service_a should succeed");

        // service_b has never had this account set
        let _ = keychain_delete_impl(service_b, &account);
        let result = keychain_get_impl(service_b, &account);
        assert!(result.is_ok(), "get on service_b should return Ok");
        assert_eq!(
            result.unwrap(),
            None,
            "service_b should not see service_a's value"
        );

        // Teardown
        let _ = keychain_delete_impl(service_a, &account);
    }
}
