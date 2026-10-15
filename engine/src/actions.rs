//! One bounded native FIFO; Lua collections are views of these records.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{begin_actor_container_fixture, stage_floor_container_fixture};
    fn clock_action(raw: f64) -> Action {
        Action::new(1, 2, 0, 1, (5, 5, 0), raw)
    }
    #[test]
    fn source_clock_zero_indefinite_nan_and_reset_keep_history() {
        let mut a = clock_action(0.0);
        a.flags |= STARTED;
        a.current = 0.0;
        assert!(a.finished());
        assert_eq!(a.current, 0.0);
        a.max = -1;
        a.delta = 0.25;
        a.advance(0.8);
        assert_eq!(a.delta, 0.25);
        a.max = 10;
        a.advance(f32::NAN);
        assert!(a.delta.is_nan());
        a.last = 2.0;
        a.prev = 1.0;
        a.reset_progress();
        assert_eq!((a.current, a.delta, a.last, a.prev), (0.0, 0.0, 2.0, 1.0));
        assert_ne!(a.flags & STARTED, 0);
    }
    #[test]
    fn stable_ids_and_detached_groups_survive_only_callback() {
        let mut s = Store::new();
        let id = s.new_action(3, 1, 9, (5, 5, 0), 12.0).unwrap();
        let gid = s.new_group(id, 12.0).unwrap();
        s.action_mut(id).unwrap().groups.push(gid);
        s.action_mut(id).unwrap().groups.remove(0);
        assert!(s.group(gid).is_some());
        s.retire(id);
        assert!(s.group(gid).is_none());
        assert!(s.new_action(2, 0, 1, (5, 5, 0), 0.0).unwrap() > id);
    }
    #[test]
    fn binary_preserves_raw_bits_and_refuses_truncation_atomically() {
        crate::reset();
        let id = queue_action_new(1, 1, 0, 5, 5, 0, f64::from_bits(0x7ff8000000001234));
        assert!(id > 0);
        assert_eq!(queue_insert(0, id as u32), OK);
        let bytes = STORE.with(|s| encode(&s.borrow()).unwrap());
        let (restored, _) = decode(&bytes).unwrap();
        assert_eq!(
            restored.action(id as u32).unwrap().raw.to_bits(),
            0x7ff8000000001234
        );
        assert!(decode(&bytes[..bytes.len() - 1]).is_err());
        assert_eq!(queue_get(0), id);
    }
    fn items_fixture(weight: f64, count: usize) -> Vec<u32> {
        crate::reset();
        assert_eq!(
            item_definition_register(0, 1, 100, 0, 1, 0, 0, 0, weight, 0),
            OK
        );
        (0..count)
            .map(|_| {
                assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OK);
                item_last_id()
            })
            .collect()
    }
    fn event() -> Event {
        STORE.with(|s| s.borrow().event.unwrap())
    }
    fn reply(result: i32) {
        let e = event();
        assert_eq!(queue_event_reply(e.action, e.kind, e.token, result), OK);
    }
    fn begin_source(id: u32) {
        assert_eq!(queue_start(id, -1.0, 1), OK);
        assert_eq!(event().kind, 1);
        reply(1);
        assert_eq!(event().kind, 2);
        reply(0);
        assert_eq!(event().kind, 3);
        reply(0);
    }
    #[test]
    fn groups_merge_into_active_last_action_with_twenty_and_first_duration() {
        let ids = items_fixture(1.0, 22);
        let action = queue_request_pickup(ids[0]) as u32;
        for id in &ids[1..20] {
            assert_eq!(queue_request_pickup(*id), action as i32);
        }
        assert_eq!(item_set_actual_weight(ids[20], 2.0), OK);
        assert_eq!(queue_request_pickup(ids[20]), action as i32);
        assert_eq!(queue_request_pickup(ids[21]), action as i32);
        assert_eq!(queue_group_length(action), 2);
        let first = queue_group_get(action, 0) as u32;
        let second = queue_group_get(action, 1) as u32;
        STORE.with(|s| {
            let s = s.borrow();
            assert_eq!(s.group(first).unwrap().items.len(), 20);
            assert_eq!(s.group(first).unwrap().raw, 48.0);
            assert_eq!(s.group(second).unwrap().raw, 96.0);
        });
        assert!(ids.iter().all(|id| item(*id).unwrap().world_object));
        assert_eq!(queue_action_set(action, 0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert!(
            ids[..20]
                .iter()
                .all(|id| item(*id).unwrap().owner_container == PLAYER_INVENTORY)
        );
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(action).unwrap();
            assert_eq!((a.max, a.current, a.delta), (96, 0.0, 0.0));
            assert_ne!(a.flags & STARTED, 0);
            assert_eq!((a.last, a.prev), (-1.0, 0.0));
        });
    }
    #[test]
    fn grouped_capacity_failure_preserves_successful_prefix() {
        let ids = items_fixture(26.0, 2);
        let id = queue_request_pickup(ids[0]) as u32;
        assert_eq!(queue_request_pickup(ids[1]), id as i32);
        assert_eq!(queue_action_set(id, 0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
        assert!(item(ids[1]).unwrap().world_object);
        assert_eq!(queue_length(), 0);
    }
    #[test]
    fn graph_source_helper_rollback_restores_order_world_and_rejects_replay() {
        let ids = items_fixture(1.0, 2);
        let source = item(ids[0]).unwrap().owner_container;
        let action = queue_action_new(5, 1, ids[0], 5, 5, 0, 0.0) as u32;
        assert_eq!(
            queue_action_bind_transfer(action, source, PLAYER_INVENTORY),
            OK
        );
        let group = queue_group_new(action, 0.0) as u32;
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert_eq!(queue_group_insert(action, 0, group), OK);
        assert_eq!(queue_insert(0, action), OK);
        begin_source(action);
        assert_eq!(queue_action_set(action, 3, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        let token = event().token;
        assert_eq!(event().kind, 5);
        assert_eq!(queue_transfer_begin(action, group, ids[0], token, 1), OK);
        assert_eq!(
            queue_transfer_operation(action, ids[0], token, 1, source, 0.0, 0.0, 0),
            OK
        );
        assert_eq!(container_item_count(source), 1);
        assert_eq!(source_world_item_count(5, 5, 0), 2);
        assert_eq!(source_world_item_get(5, 5, 0, 0), ids[0] as f64);
        assert_eq!(
            queue_transfer_operation(action, ids[0], token, 2, source, 0.0, 0.0, 0),
            OUT_OF_RANGE
        );
        assert_eq!(
            queue_transfer_operation(action, ids[0], token, 3, source, 0.0, 0.0, 0),
            OK
        );
        assert_eq!(source_world_item_count(5, 5, 0), 1);
        assert_eq!(source_world_item_get(5, 5, 0, 0), ids[1] as f64);
        assert_eq!(queue_transfer_finish(action, ids[0], token, 0), OK);
        assert_eq!(container_item_get(source, 0), ids[0] as f64);
        assert_eq!(source_world_item_count(5, 5, 0), 2);
        assert_eq!(
            queue_transfer_begin(action, group, ids[0], token, 1),
            OUT_OF_RANGE
        );
    }
    #[test]
    fn detached_bag_keeps_its_real_outermost_container_during_transfer_callback() {
        items_fixture(1.0, 0);
        assert_eq!(
            item_definition_register(1, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(
            item_definition_container_set(1, 1, 1, 10, 0, 0.0, 1, 1, 0, 0, 0),
            OK
        );
        assert_eq!(item_spawn(1, 5.0, 5.0, 1, 100), OK);
        let shell = item_last_id();
        let bag = item(shell).unwrap().internal_container;
        let source = item(shell).unwrap().owner_container;
        assert_eq!(container_outermost(bag), source as f64);
        let action = queue_action_new(5, 1, shell, 5, 5, 0, 0.0) as u32;
        assert_eq!(
            queue_action_bind_transfer(action, source, PLAYER_INVENTORY),
            OK
        );
        let group = queue_group_new(action, 0.0) as u32;
        assert_eq!(queue_group_item_insert(group, 0, shell), OK);
        assert_eq!(queue_group_insert(action, 0, group), OK);
        assert_eq!(queue_insert(0, action), OK);
        begin_source(action);
        assert_eq!(queue_action_set(action, 3, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        let token = event().token;
        assert_eq!(event().kind, 5);
        assert_eq!(queue_transfer_begin(action, group, shell, token, 1), OK);
        assert_eq!(
            queue_transfer_operation(action, shell, token, 1, source, 0.0, 0.0, 0),
            OK
        );
        assert_eq!(item(shell).unwrap().owner_container, 0);
        assert_eq!(container_outermost(bag), bag as f64);
        assert_eq!(queue_transfer_finish(action, shell, token, 0), OK);
        assert_eq!(container_outermost(bag), source as f64);
    }

    #[test]
    fn queue_v2_ground_restore_rejects_bag_references_atomically_and_keeps_floor_sources() {
        let ids = items_fixture(1.0, 2);
        assert_eq!(item_spawn(0, 6.0, 5.0, 1, 100), OK);
        let other_ground = item_last_id();
        let first_floor = item(ids[0]).unwrap().owner_container;
        let other_floor = item(other_ground).unwrap().owner_container;
        assert_ne!(first_floor, other_floor);
        assert_eq!(
            item_definition_register(1, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(
            item_definition_container_set(1, 1, 1, 10, 0, 0.0, 1, 1, 0, 0, 0),
            OK
        );
        assert_eq!(item_spawn(1, 5.0, 5.0, 1, 100), OK);
        let bag = item(item_last_id()).unwrap().internal_container;
        ITEMS.with(|items| {
            let mut items = items.borrow_mut();
            let nested = items
                .live
                .iter_mut()
                .find(|item| item.id == ids[1])
                .unwrap();
            nested.owner_container = bag;
            nested.world_object = false;
        });
        let action = queue_action_new(3, 1, ids[0], 5, 5, 0, 0.0) as u32;
        let group = queue_group_new(action, 0.0) as u32;
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert_eq!(queue_group_item_insert(group, 1, other_ground), OK);
        assert_eq!(queue_group_insert(action, 0, group), OK);
        assert_eq!(queue_insert(0, action), OK);
        let bytes = STORE.with(|store| encode(&store.borrow()).unwrap());
        assert_eq!(stage_bytes(&bytes), OK);
        assert_eq!(queue_group_item_source_get(group, 0), first_floor as f64);
        assert_eq!(queue_group_item_source_get(group, 1), other_floor as f64);
        let before = STORE.with(|store| encode(&store.borrow()).unwrap());
        let clock = timing::snapshot_words();
        let timing_count = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        let action_at = 44 + timing_count * 4 + 12;
        // One group: 24-byte header followed by two (item, source) pairs.
        let group_at = bytes.len() - 40;
        for corruption in 0..4 {
            let mut malformed = bytes.clone();
            match corruption {
                0 => malformed[action_at + 32..action_at + 36].copy_from_slice(&bag.to_le_bytes()),
                1 => {
                    malformed[action_at + 12..action_at + 16]
                        .copy_from_slice(&ids[1].to_le_bytes());
                    malformed[action_at + 28..action_at + 32].copy_from_slice(&bag.to_le_bytes());
                    malformed[group_at + 24..group_at + 28].copy_from_slice(&ids[1].to_le_bytes());
                    malformed[group_at + 28..group_at + 32].copy_from_slice(&bag.to_le_bytes());
                }
                2 => {
                    malformed[group_at + 32..group_at + 36].copy_from_slice(&ids[1].to_le_bytes());
                    malformed[group_at + 36..group_at + 40].copy_from_slice(&bag.to_le_bytes());
                }
                _ => malformed[group_at + 36..group_at + 40]
                    .copy_from_slice(&first_floor.to_le_bytes()),
            }
            assert_eq!(stage_bytes(&malformed), BAD_FORMAT);
            assert_eq!(STORE.with(|store| encode(&store.borrow()).unwrap()), before);
            assert_eq!(timing::snapshot_words(), clock);
            assert_eq!(queue_group_item_source_get(group, 0), first_floor as f64);
            assert_eq!(queue_group_item_source_get(group, 1), other_floor as f64);
        }
        assert_eq!(queue_clear(), OK);
        let general = queue_action_new(5, 1, ids[1], 5, 5, 0, 0.0) as u32;
        assert_eq!(queue_action_bind_transfer(general, bag, first_floor), OK);
        let group = queue_group_new(general, 0.0) as u32;
        assert_eq!(queue_group_item_insert(group, 0, ids[1]), OK);
        assert_eq!(queue_group_insert(general, 0, group), OK);
        assert_eq!(queue_insert(0, general), OK);
        let bytes = STORE.with(|store| encode(&store.borrow()).unwrap());
        assert_eq!(stage_bytes(&bytes), OK);
        assert_eq!(queue_group_item_source_get(group, 0), bag as f64);
    }

    #[test]
    fn source_callbacks_tokens_detached_batch_and_partial_error_are_authoritative() {
        let ids = items_fixture(1.0, 2);
        let id = queue_action_new(3, 1, ids[0], 5, 5, 0, 0.0) as u32;
        let group = queue_group_new(id, 0.0) as u32;
        for (i, item) in ids.iter().enumerate() {
            assert_eq!(queue_group_item_insert(group, i as u32, *item), OK);
        }
        let future = queue_group_new(id, 1.0) as u32;
        assert_eq!(queue_group_item_insert(future, 0, ids[1]), OK);
        assert_eq!(queue_group_insert(id, 0, group), OK);
        assert_eq!(queue_group_insert(id, 1, future), OK);
        assert_eq!(queue_insert(0, id), OK);
        assert_eq!(queue_start(id, 0.0, 1), OK);
        reply(1);
        reply(0);
        reply(0);
        assert_eq!(step(0.0), OK);
        reply(1);
        let e = event();
        assert_eq!(e.kind, 5);
        assert_eq!(queue_group_remove(id, 0), group as i32);
        assert_eq!(
            queue_commit_item(id, group, ids[0], e.token + 1),
            OUT_OF_RANGE
        );
        assert_eq!(
            queue_commit_item(id + 1, group, ids[0], e.token),
            OUT_OF_RANGE
        );
        assert_eq!(queue_commit_item(id, future, ids[1], e.token), OUT_OF_RANGE);
        assert_eq!(queue_commit_item(id, group, ids[0], e.token), OK);
        assert_ne!(queue_commit_item(id, group, ids[0], e.token), OK);
        assert_eq!(queue_event_reply(id, 5, e.token, -4), OK);
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
        assert!(item(ids[1]).unwrap().world_object);
        assert_eq!(queue_group_read(group), OUT_OF_RANGE);
        assert_eq!(queue_length(), 0);
        assert_eq!(queue_event_reply(id, 5, e.token, 0), OUT_OF_RANGE);
    }
    #[test]
    fn source_perform_starts_next_without_same_frame_drain_and_clear_preserves_token() {
        crate::reset();
        let first = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, first), OK);
        begin_source(first);
        assert_eq!(queue_action_set(first, 3, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 5);
        let e = event();
        assert_eq!(queue_remove(0), first as i32);
        assert_eq!(queue_clear(), OK);
        assert_eq!(event().token, e.token);
        let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, next), OK);
        assert_eq!(queue_start(next, -1.0, 1), OK);
        assert_eq!(event().action, first);
        reply(0);
        assert_eq!(event().action, next);
        reply(1);
        reply(0);
        reply(0);
        STORE.with(|s| {
            let s = s.borrow();
            assert_eq!(s.action(next).unwrap().current, 0.0);
        });
        assert_eq!(queue_current(), next as i32);
    }
    #[test]
    fn staged_bad_restore_does_not_publish_clock_ids_or_queue_and_opaque_refuses_save() {
        crate::reset();
        let id = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, id), OK);
        let before = timing::snapshot_words();
        assert_eq!(queue_restore_begin(4), OK);
        QUEUE_SCRATCH.with(|s| s.borrow_mut()[0] = 0);
        assert_eq!(queue_restore_write(0, 4), OK);
        assert_eq!(queue_restore_commit(), BAD_FORMAT);
        assert_eq!(queue_get(0), id as i32);
        assert_eq!(timing::snapshot_words(), before);
        assert_eq!(queue_action_set(id, 10, 0.0), OK);
        assert_eq!(queue_save_size(), OUT_OF_RANGE);
        assert_eq!(queue_action_discard(id), OUT_OF_RANGE);
        assert_eq!(queue_clear(), OK);
        assert_eq!(queue_action_read(id), OUT_OF_RANGE);
    }
    #[test]
    fn movement_cancel_and_definition_guard_refuse_stale_queue_ids() {
        let ids = items_fixture(1.0, 1);
        let id = queue_request_pickup(ids[0]);
        assert!(id > 0);
        assert_eq!(walk(1.0, 0.0), OK);
        assert_eq!(queue_action_read(id as u32), OUT_OF_RANGE);
        assert!(item(ids[0]).unwrap().world_object);
        assert_eq!(item_definition_begin(1), OK);
        assert_eq!(queue_request_pickup(ids[0]), OUT_OF_RANGE);
        assert_eq!(item_definition_rollback(1), OK);
        assert!(queue_request_pickup(ids[0]) > id);
    }
    #[test]
    fn full_uint32_item_ids_survive_sdk_and_source_queue_views_restore_and_transfer() {
        for source in [false, true] {
            items_fixture(1.0, 0);
            ENGINE.with(|engine| engine.borrow_mut().next_item_id = u32::MAX as u64);
            assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OK);
            let item_id = item_last_id();
            assert_eq!(item_id, u32::MAX);
            let id = if source {
                let id = queue_action_new(3, 1, item_id, 5, 5, 0, 0.0);
                assert!(id > 0);
                let group = queue_group_new(id as u32, 0.0) as u32;
                assert_eq!(queue_group_item_insert(group, 0, item_id), OK);
                assert_eq!(queue_group_insert(id as u32, 0, group), OK);
                assert_eq!(queue_insert(0, id as u32), OK);
                id as u32
            } else {
                let id = queue_request_pickup(item_id);
                assert!(id > 0);
                id as u32
            };
            let group = queue_group_get(id, 0) as u32;
            assert_eq!(queue_group_item_get(group, 0), item_id as f64);
            assert_eq!(queue_group_item_remove(group, 0), item_id as f64);
            assert_eq!(queue_group_item_insert(group, 0, item_id), OK);
            assert!(queue_save_size() > 0);
            let bytes = SAVED.with(|saved| saved.borrow().clone());
            assert_eq!(stage_bytes(&bytes), OK);
            assert_eq!(queue_action_read(id), OK);
            assert_eq!(
                QUEUE_SCRATCH.with(|s| f64::from_bits(s.borrow()[3])),
                item_id as f64
            );
            assert_eq!(queue_group_item_get(group, 0), item_id as f64);
            if source {
                begin_source(id);
                assert_eq!(queue_action_set(id, 3, 1.0), OK);
                assert_eq!(step(0.0), OK);
                reply(1);
                assert_eq!(event().kind, 5);
                let token = event().token;
                assert_eq!(queue_group_remove(id, 0), group as i32);
                assert_eq!(queue_commit_item(id, group, item_id, token), OK);
                assert_eq!(queue_commit_item(id, group, item_id, token), OUT_OF_RANGE);
                assert_eq!(queue_remove(0), id as i32);
                reply(0);
            } else {
                assert_eq!(queue_action_set(id, 0, 0.0), OK);
                assert_eq!(step(0.0), OK);
            }
            assert_eq!(item(item_id).unwrap().owner_container, PLAYER_INVENTORY);
            assert_eq!(queue_length(), 0);
            assert_eq!(item_last_id(), item_id);
            assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OUT_OF_RANGE);
        }
    }
    #[test]
    fn counts_refuse_without_recycling_ids_or_mutating_existing_records() {
        let mut s = Store::new();
        let id = s.new_action(3, 1, 1, (5, 5, 0), 1.0).unwrap();
        for _ in 0..GROUPS {
            assert!(s.new_group(id, 1.0).is_ok());
        }
        let next = s.next_group;
        assert_eq!(s.new_group(id, 1.0), Err(OUT_OF_RANGE));
        assert_eq!(s.next_group, next);
        for _ in 1..ACTIONS {
            assert!(s.new_action(1, 0, 0, (5, 5, 0), -1.0).is_ok());
        }
        assert_eq!(s.new_action(1, 0, 0, (5, 5, 0), -1.0), Err(OUT_OF_RANGE));
        assert_eq!(s.actions.len(), ACTIONS);
        assert_eq!(s.groups.len(), GROUPS);
    }
    #[test]
    fn malformed_flags_and_fifo_ids_refuse_raw_bit_payload() {
        crate::reset();
        let id = queue_action_new(1, 1, 0, 5, 5, 0, 0.0) as u32;
        assert_eq!(queue_insert(0, id), OK);
        STORE.with(|s| {
            let mut s = s.borrow_mut();
            let a = s.action_mut(id).unwrap();
            a.current = f32::from_bits(0x7fc01234);
            a.delta = f32::from_bits(0xff800000);
        });
        let bytes = STORE.with(|s| encode(&s.borrow()).unwrap());
        let (restored, _) = decode(&bytes).unwrap();
        let a = restored.action(id).unwrap();
        assert_eq!(a.current.to_bits(), 0x7fc01234);
        assert_eq!(a.delta.to_bits(), 0xff800000);
        let timing_count = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        let action_at = 44 + timing_count * 4 + 12;
        let mut malformed = bytes.clone();
        malformed[action_at + 72..action_at + 76].copy_from_slice(&256u32.to_le_bytes());
        assert!(decode(&malformed).is_err());
        let mut malformed = bytes;
        malformed[action_at..action_at + 4].copy_from_slice(&0u32.to_le_bytes());
        assert!(decode(&malformed).is_err());
        assert_eq!(queue_get(0), id as i32);
    }
    #[test]
    fn restore_stream_publishes_queue_and_raw_timing_together() {
        crate::reset();
        let id = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, id), OK);
        let clock = timing::snapshot_words();
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(queue_clear(), OK);
        assert_eq!(timing::source_timing_set(0, 2.0), OK);
        assert_eq!(queue_restore_begin(bytes.len() as u32), OK);
        for (index, chunk) in bytes.chunks(4096).enumerate() {
            QUEUE_SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                s.fill(0);
                for (i, byte) in chunk.iter().enumerate() {
                    s[i / 8] |= (*byte as u64) << ((i % 8) * 8);
                }
            });
            assert_eq!(
                queue_restore_write((index * 4096) as u32, chunk.len() as u32),
                OK
            );
        }
        assert_eq!(queue_restore_commit(), OK);
        assert_eq!(queue_get(0), id as i32);
        assert_eq!(timing::snapshot_words(), clock);
    }
    #[test]
    fn raw_frame_caps_movement_only_and_zero_step_is_one_logic_frame() {
        crate::reset();
        assert_eq!(walk(1.0, 0.0), OK);
        assert_eq!(frame_step(1.0), OK);
        assert!((position_x() - 5.15).abs() < 0.000001);
        assert_eq!(timing::elapsed_seconds(), 1.0);
        assert_eq!(timing::multiplier(), 4.0);
        let x = position_x();
        assert_eq!(step(0.0), OK);
        assert_eq!(position_x(), x);
        assert_eq!(tick(), 2);
        assert_eq!(timing::elapsed_seconds(), 0.0);
        assert_eq!(timing::multiplier(), 4.0);
    }
    fn stage_bytes(bytes: &[u8]) -> i32 {
        assert_eq!(queue_restore_begin(bytes.len() as u32), OK);
        for (index, chunk) in bytes.chunks(4096).enumerate() {
            QUEUE_SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                s.fill(0);
                for (i, byte) in chunk.iter().enumerate() {
                    s[i / 8] |= (*byte as u64) << ((i % 8) * 8);
                }
            });
            assert_eq!(
                queue_restore_write((index * 4096) as u32, chunk.len() as u32),
                OK
            );
        }
        queue_restore_commit()
    }
    #[test]
    fn source_walk_updates_clock_and_consumes_failed_path_stop_in_same_frame() {
        let ids = items_fixture(1.0, 1);
        let walk = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
        assert_eq!(queue_action_set(walk, 6, 0.0), OK);
        assert_eq!(queue_insert(0, walk), OK);
        begin_source(walk);
        let grab = queue_action_new(3, 1, ids[0], 5, 5, 0, 1.0) as u32;
        let group = queue_group_new(grab, 1.0) as u32;
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert_eq!(queue_group_insert(grab, 0, group), OK);
        assert_eq!(queue_insert(1, grab), OK);
        assert_eq!(source_path_result(walk), 0);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 4);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(walk).unwrap();
            assert_eq!((a.current, a.last, a.prev), (0.8, 0.0, -1.0));
        });
        reply(0);
        assert_eq!(queue_event_read(), 0);
        assert_eq!(move_to(8.0, 8.0), OK);
        assert_eq!(source_path_result(walk), 2);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 4);
        assert_eq!(queue_action_set(walk, 4, 1.0), OK);
        reply(0);
        assert_eq!(event().kind, 6);
        assert_eq!(event().action, walk);
        assert_eq!(source_path_cancel(), OK);
        assert_eq!(action(), ACTION_DESTINATION);
        assert_eq!(queue_clear(), OK);
        reply(0);
        assert_eq!(queue_length(), 0);
        assert!(item(ids[0]).unwrap().world_object);
    }
    #[test]
    fn completion_precedes_same_frame_stop_and_never_ticks_successor() {
        crate::reset();
        let id = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, id), OK);
        begin_source(id);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 4);
        assert_eq!(queue_action_set(id, 3, 1.0), OK);
        assert_eq!(queue_action_set(id, 4, 1.0), OK);
        reply(0);
        assert_eq!(event().kind, 5);
        assert_eq!(queue_remove(0), id as i32);
        reply(0);
        assert_eq!(event().kind, 6);
        assert_eq!(event().action, id);
        assert_eq!(tick(), 1);
        reply(0);
        assert_eq!(queue_length(), 0);
    }
    #[test]
    fn older_stop_reply_preserves_replacement_and_failed_stop_fully_recovers() {
        crate::reset();
        let old = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, old), OK);
        begin_source(old);
        assert_eq!(queue_clear(), OK);
        let stop = event();
        assert_eq!(stop.kind, 6);
        let next = queue_action_new(1, 1, 0, 7, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, next), OK);
        assert_eq!(queue_start(next, -1.0, 1), OK);
        assert_eq!(queue_event_reply(old, 6, stop.token, 0), OK);
        assert_eq!(queue_get(0), next as i32);
        assert_eq!(event().action, next);
        reply(1);
        reply(0);
        reply(0);
        assert_eq!(source_path_result(next), 0);
        assert_eq!(source_retrigger_set(next), OK);
        assert_eq!(queue_clear(), OK);
        reply(-4);
        assert_eq!(source_retrigger_get(), 0);
        let fresh = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, fresh), OK);
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(stage_bytes(&bytes), OK);
    }
    #[test]
    fn item_authorization_survives_index_edits_but_cannot_replay_after_drop() {
        let ids = items_fixture(1.0, 3);
        let id = queue_action_new(3, 1, ids[0], 5, 5, 0, 0.0) as u32;
        let group = queue_group_new(id, 0.0) as u32;
        for (index, item) in ids[..2].iter().enumerate() {
            assert_eq!(queue_group_item_insert(group, index as u32, *item), OK);
        }
        assert_eq!(queue_group_insert(id, 0, group), OK);
        assert_eq!(queue_insert(0, id), OK);
        assert_eq!(queue_start(id, 0.0, 1), OK);
        reply(1);
        reply(0);
        reply(0);
        assert_eq!(step(0.0), OK);
        reply(1);
        let token = event().token;
        assert_eq!(queue_group_remove(id, 0), group as i32);
        assert_eq!(queue_commit_item(id, group, ids[0], token), OK);
        assert_eq!(item_drop(ids[0], 5.0, 5.0), OK);
        assert_eq!(queue_group_item_remove(group, 0), ids[0] as f64);
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert_eq!(queue_commit_item(id, group, ids[0], token), OUT_OF_RANGE);
        assert_eq!(queue_group_item_insert(group, 2, ids[2]), OK);
        assert_eq!(queue_commit_item(id, group, ids[2], token), OUT_OF_RANGE);
        assert_eq!(queue_group_item_remove(group, 1), ids[1] as f64);
        assert_eq!(queue_commit_item(id, group, ids[1], token), OK);
        assert_eq!(queue_remove(0), id as i32);
        reply(0);
        let fresh = queue_request_pickup(ids[0]) as u32;
        assert!(fresh > id);
        assert_eq!(queue_action_set(fresh, 0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
    }
    #[test]
    fn empty_future_sdk_group_refuses_without_trap_after_successful_prefix() {
        let ids = items_fixture(1.0, 21);
        let id = queue_request_pickup(ids[0]) as u32;
        for item in &ids[1..] {
            assert_eq!(queue_request_pickup(*item), id as i32);
        }
        let future = queue_group_get(id, 1) as u32;
        assert_eq!(queue_group_item_remove(future, 0), ids[20] as f64);
        assert_eq!(queue_save_size(), OUT_OF_RANGE);
        assert_eq!(queue_current(), id as i32);
        assert_eq!(queue_length(), 1);
        assert_eq!(queue_group_length(id), 2);
        assert_eq!(queue_group_item_length(future), 0);
        assert!(ids.iter().all(|id| item(*id).unwrap().world_object));
        assert_eq!(queue_action_set(id, 0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert!(
            ids[..20]
                .iter()
                .all(|id| item(*id).unwrap().owner_container == PLAYER_INVENTORY)
        );
        assert!(item(ids[20]).unwrap().world_object);
        assert_eq!(queue_current(), 0);
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(stage_bytes(&bytes), OK);
        assert_retired_queue();
    }
    #[test]
    fn source_continuation_target_and_fractional_max_survive_consumed_item_move() {
        let ids = items_fixture(1.0, 22);
        let id = queue_action_new(3, 1, ids[0], 5, 5, 0, 9.60000014) as u32;
        let first = queue_group_new(id, 9.60000014) as u32;
        let future = queue_group_new(id, 2.75) as u32;
        for (index, item) in ids[..20].iter().enumerate() {
            assert_eq!(queue_group_item_insert(first, index as u32, *item), OK);
        }
        for (index, item) in ids[20..].iter().enumerate() {
            assert_eq!(queue_group_item_insert(future, index as u32, *item), OK);
        }
        assert_eq!(queue_group_insert(id, 0, first), OK);
        assert_eq!(queue_group_insert(id, 1, future), OK);
        assert_eq!(queue_insert(0, id), OK);
        assert_eq!(queue_start(id, 9.60000014, 1), OK);
        reply(1);
        reply(0);
        reply(0);
        assert_eq!(queue_action_set(id, 3, 1.0), OK);
        assert_eq!(queue_action_set(id, 11, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        let token = event().token;
        assert_eq!(queue_group_remove(id, 0), first as i32);
        for item in &ids[..20] {
            assert_eq!(queue_commit_item(id, first, *item, token), OK);
        }
        assert_eq!(queue_action_set(id, 0, 2.75), OK);
        assert_eq!(queue_action_set(id, 2, 1.0), OK);
        assert_eq!(queue_action_set(id, 11, 0.0), OK);
        reply(0);
        assert_eq!(item_drop(ids[0], 8.0, 8.0), OK);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(id).unwrap();
            assert_eq!(
                (a.target, a.xyz, a.max, a.source_time),
                (ids[20], (5, 5, 0), 2, 2.75)
            );
            assert_ne!(a.flags & STARTED, 0);
            assert_eq!(a.flags & COMPLETE, 0);
        });
        assert_eq!(queue_source_time_read(id), OK);
        assert_eq!(QUEUE_SCRATCH.with(|s| f64::from_bits(s.borrow()[0])), 2.75);
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(stage_bytes(&bytes), OK);
        assert_eq!(queue_current(), id as i32);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(id).unwrap();
            assert_ne!(a.flags & STARTED, 0);
            assert_eq!(a.flags & SOURCE_GRAB_STARTED, 0);
        });
    }
    #[test]
    fn definition_rebound_rejects_old_queue_without_publishing_old_clock() {
        let ids = items_fixture(1.0, 1);
        assert_eq!(
            item_definition_register(1, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert!(queue_request_pickup(ids[0]) > 0);
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(begin_actor_container_fixture(), OK);
        let floor = container_next_id() as u32;
        stage_floor_container_fixture(floor, 5, 5);
        assert_eq!(
            item_import_stage(ids[0], 1, floor, 5.0, 5.0, 100, 1, 0, 1.0, 1.0, 0, 1),
            OK
        );
        assert_eq!(item_import_commit(), OK);
        let fresh = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, fresh), OK);
        assert_eq!(timing::source_trait_set(0, 1), OK);
        let before = STORE.with(|s| encode(&s.borrow()).unwrap());
        let clock = timing::snapshot_words();
        assert_eq!(stage_bytes(&bytes), BAD_FORMAT);
        assert_eq!(STORE.with(|s| encode(&s.borrow()).unwrap()), before);
        assert_eq!(timing::snapshot_words(), clock);
    }
    #[test]
    fn refused_pending_start_is_bit_identical_and_sdk_supplied_time_adjusts_once() {
        crate::reset();
        let first = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, first), OK);
        begin_source(first);
        assert_eq!(queue_insert(1, next), OK);
        let before = STORE.with(|s| encode(&s.borrow()).unwrap());
        assert_eq!(queue_start(next, 77.0, 1), OUT_OF_RANGE);
        assert_eq!(STORE.with(|s| encode(&s.borrow()).unwrap()), before);
        assert_eq!(queue_clear(), OK);
        reply(0);
        assert_eq!(set_character_stat(6, 70.0), OK);
        let sdk = queue_action_new(1, 0, 0, 6, 5, 0, 10.0) as u32;
        assert_eq!(queue_insert(0, sdk), OK);
        assert_eq!(queue_start(sdk, 20.0, 0), OK);
        STORE.with(|s| assert_eq!(s.borrow().action(sdk).unwrap().max, 35));
    }
    #[test]
    fn glove_modifier_uses_canonical_hands_and_binding_rolls_back() {
        let ids = items_fixture(1.0, 1);
        let hands = BODY_LOCATIONS.with(|r| r.borrow().lookup("base:hands").unwrap());
        let other = BODY_LOCATIONS.with(|r| r.borrow().lookup("base:back").unwrap());
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(body_group_location_add(1, other), OK);
        assert_eq!(
            item_definition_register(1, 1, 100, other, 1, 0, 0, 0, 0.0, 1),
            OK
        );
        assert_eq!(
            item_definition_register(2, 1, 100, hands, 1, 0, 0, 0, 0.0, 1),
            OK
        );
        assert_eq!(source_hands_slot_set(hands), OK);
        assert_eq!(item_spawn(1, 5.0, 5.0, 1, 100), OK);
        let tagged_other = item_last_id();
        assert!(queue_request_pickup(tagged_other) > 0);
        assert_eq!(step(0.0), OK);
        assert_eq!(item_wear(tagged_other), OK);
        let base = queue_request_pickup(ids[0]) as u32;
        STORE.with(|s| assert_eq!(s.borrow().action(base).unwrap().raw, 48.0));
        assert_eq!(queue_clear(), OK);
        assert_eq!(item_spawn(2, 5.0, 5.0, 1, 100), OK);
        let glove = item_last_id();
        assert!(queue_request_pickup(glove) > 0);
        assert_eq!(step(0.0), OK);
        assert_eq!(item_wear(glove), OK);
        assert_eq!(timing::source_trait_set(1, 1), OK);
        let slow = queue_request_pickup(ids[0]) as u32;
        STORE.with(|s| assert_eq!(s.borrow().action(slow).unwrap().raw, 96.0));
        assert_eq!(queue_clear(), OK);
        assert_eq!(item_definition_begin(1), OK);
        assert_eq!(source_hands_slot_set(99), OK);
        assert_eq!(item_definition_rollback(1), OK);
        assert_eq!(item_wearing_awkward_gloves(hands), 1);
        assert_eq!(ITEMS.with(|s| s.borrow().hands_slot), hands);
    }
    #[test]
    fn private_source_phase_flag_refuses_wrong_origin_kind_and_non_boolean() {
        let ids = items_fixture(1.0, 1);
        let sdk = queue_request_pickup(ids[0]) as u32;
        let before = STORE.with(|s| encode(&s.borrow()).unwrap());
        assert_eq!(queue_action_set(sdk, 11, 1.0), OUT_OF_RANGE);
        assert_eq!(STORE.with(|s| encode(&s.borrow()).unwrap()), before);
        assert_eq!(queue_clear(), OK);
        let source = queue_action_new(3, 1, ids[0], 5, 5, 0, 1.0) as u32;
        assert_eq!(queue_action_set(source, 11, f64::NAN), OUT_OF_RANGE);
        assert_eq!(queue_action_set(source, 11, 2.0), OUT_OF_RANGE);
        let door_wait = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_action_set(door_wait, 11, 1.0), OUT_OF_RANGE);
        assert_eq!(queue_action_set(source, 11, 1.0), OK);
        STORE.with(|s| {
            assert_ne!(
                s.borrow().action(source).unwrap().flags & SOURCE_GRAB_STARTED,
                0
            )
        });
    }
    #[test]
    fn supported_constructor_stop_flags_are_source_values_and_sdk_walk_clock_is_live() {
        assert_eq!(Action::new(1, 1, 0, 0, (6, 5, 0), -1.0).flags, 0);
        assert_eq!(Action::new(2, 2, 0, 1, (5, 5, 0), 0.0).flags, 0);
        assert_eq!(
            Action::new(3, 3, 0, 1, (5, 5, 0), 1.0).flags,
            WALK | RUN | LOOP
        );
        crate::reset();
        let walk = queue_request_walk(6, 5, 0);
        assert!(walk > 0);
        assert_eq!(step(0.0), OK);
        STORE.with(|s| assert_eq!(s.borrow().action(walk as u32).unwrap().current, 0.8));
        assert_eq!(crate::walk(1.0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert_eq!(queue_current(), 0);
        assert_eq!(action(), ACTION_WALKING);
    }
    #[test]
    fn sdk_additions_merge_into_source_head_without_changing_owner_clock_or_source_phase() {
        let ids = items_fixture(1.0, 22);
        let source = queue_action_new(3, 1, ids[0], 5, 5, 0, 7.5) as u32;
        let group = queue_group_new(source, 7.5) as u32;
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert_eq!(queue_group_insert(source, 0, group), OK);
        assert_eq!(queue_insert(0, source), OK);
        assert_eq!(queue_start(source, 7.5, 1), OK);
        reply(1);
        reply(0);
        reply(0);
        assert_eq!(queue_action_set(source, 11, 1.0), OK);
        for item in &ids[1..] {
            assert_eq!(queue_request_pickup(*item), source as i32);
        }
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(source).unwrap();
            assert_eq!(
                (a.origin, a.raw, a.source_time, a.max, a.current),
                (1, 7.5, 7.5, 7, 0.0)
            );
            assert_ne!(a.flags & SOURCE_GRAB_STARTED, 0);
            assert_eq!(s.group(group).unwrap().raw, 7.5);
            assert_eq!(s.group(group).unwrap().items.len(), 20);
            assert_eq!(a.groups.len(), 2);
        });
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        let token = event().token;
        assert_eq!(event().kind, 5);
        assert_eq!(queue_group_remove(source, 0), group as i32);
        for item in &ids[..20] {
            assert_eq!(queue_commit_item(source, group, *item, token), OK);
        }
        assert!(
            ids[..20]
                .iter()
                .all(|id| item(*id).unwrap().owner_container == PLAYER_INVENTORY)
        );
        assert!(ids[20..].iter().all(|id| item(*id).unwrap().world_object));
        assert_eq!(queue_action_set(source, 0, 48.0), OK);
        assert_eq!(queue_action_set(source, 2, 1.0), OK);
        assert_eq!(queue_action_set(source, 11, 0.0), OK);
        reply(0);
        STORE.with(|s| assert_eq!(s.borrow().action(source).unwrap().origin, 1));
    }
    fn enqueue_source_grab(item_id: u32, raw: f64) -> u32 {
        let id = queue_action_new(3, 1, item_id, 5, 5, 0, raw) as u32;
        let group = queue_group_new(id, raw) as u32;
        assert_eq!(queue_group_item_insert(group, 0, item_id), OK);
        assert_eq!(queue_group_insert(id, 0, group), OK);
        assert_eq!(queue_insert(queue_length(), id), OK);
        id
    }
    #[test]
    fn sdk_walk_successor_requires_once_source_begin_before_validation_without_ticking_it() {
        let ids = items_fixture(1.0, 2);
        assert_eq!(set_character_stat(6, 70.0), OK);
        assert_eq!(set_speed(10.0), OK);
        let sdk_grab = queue_request_pickup(ids[0]) as u32;
        let sdk_walk = queue_request_walk(5, 5, 0) as u32;
        let source = enqueue_source_grab(ids[1], 20.0);
        assert_eq!(queue_action_set(sdk_grab, 0, 0.0), OK);
        assert_eq!(step(0.0), OK);
        assert_eq!(queue_current(), sdk_walk as i32);
        assert_eq!(step(0.1), OK);
        let begin = event();
        assert_eq!((begin.action, begin.kind, begin.frame), (source, 7, false));
        assert_eq!(queue_current(), source as i32);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(source).unwrap();
            assert_eq!(
                (a.raw, a.max, a.source_time, a.current, a.flags & STARTED),
                (20.0, 20, 20.0, -2.0, 0)
            );
        });
        assert_eq!(queue_event_reply(source, 7, begin.token, 0), OUT_OF_RANGE);
        assert_eq!(queue_start(source, 35.0, 0), OUT_OF_RANGE);
        assert_eq!(queue_start(source, 35.0, 1), OK);
        assert_eq!(event().kind, 7);
        assert_eq!(queue_start(source, 36.0, 1), OUT_OF_RANGE);
        reply(0);
        assert_eq!((event().kind, event().frame), (1, false));
        assert_eq!(queue_start(source, 36.0, 1), OUT_OF_RANGE);
        reply(1);
        reply(0);
        reply(0);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(source).unwrap();
            assert_eq!(
                (a.raw, a.max, a.source_time, a.current, a.last, a.prev),
                (20.0, 35, 35.0, 0.0, -1.0, 0.0)
            );
        });
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
        assert!(item(ids[1]).unwrap().world_object);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 4);
        STORE.with(|s| assert!(s.borrow().action(source).unwrap().current > 0.0));
        reply(0);
    }
    #[test]
    fn source_grab_then_sdk_walk_then_sdk_grab_keeps_commit_owners_and_fresh_time() {
        let ids = items_fixture(1.0, 2);
        assert_eq!(set_character_stat(6, 70.0), OK);
        assert_eq!(set_speed(10.0), OK);
        let source = enqueue_source_grab(ids[0], 20.0);
        assert_eq!(queue_start(source, 35.0, 1), OK);
        reply(1);
        reply(0);
        reply(0);
        let sdk_walk = queue_request_walk(5, 5, 0) as u32;
        let sdk_grab = queue_request_pickup(ids[1]) as u32;
        assert_ne!(sdk_grab, source);
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        assert_eq!(step(0.0), OK);
        reply(1);
        let perform = event();
        assert_eq!(perform.kind, 5);
        let group = queue_group_get(source, 0) as u32;
        assert_eq!(queue_commit_item(source, group, ids[0], perform.token), OK);
        assert_eq!(queue_remove(0), source as i32);
        reply(0);
        assert_eq!(queue_current(), sdk_walk as i32);
        assert_eq!(step(0.1), OK);
        assert_eq!(queue_event_read(), 0);
        assert_eq!(queue_current(), sdk_grab as i32);
        STORE.with(|s| {
            let s = s.borrow();
            let a = s.action(sdk_grab).unwrap();
            assert_eq!((a.origin, a.raw, a.max, a.current), (0, 48.0, 84, 0.0));
        });
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
        assert!(item(ids[1]).unwrap().world_object);
    }
    #[test]
    fn explicit_fresh_start_clears_force_flags_before_source_start_can_set_new_ones() {
        for field in [3, 4] {
            let ids = items_fixture(1.0, 1);
            let sdk = queue_request_pickup(ids[0]) as u32;
            assert_eq!(queue_action_set(sdk, field, 1.0), OK);
            assert_eq!(queue_start(sdk, 20.0, 0), OK);
            STORE.with(|s| {
                let s = s.borrow();
                let a = s.action(sdk).unwrap();
                assert_eq!(
                    (a.flags & (COMPLETE | STOP), a.current, a.max),
                    (0, 0.0, 20)
                );
            });
            assert_eq!(step(0.0), OK);
            assert_eq!(queue_current(), sdk as i32);
            assert!(item(ids[0]).unwrap().world_object);
        }
        crate::reset();
        let source = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, source), OK);
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        assert_eq!(queue_action_set(source, 4, 1.0), OK);
        assert_eq!(queue_start(source, -1.0, 1), OK);
        reply(1);
        reply(0);
        assert_eq!(event().kind, 3);
        STORE.with(|s| {
            assert_eq!(
                s.borrow().action(source).unwrap().flags & (COMPLETE | STOP),
                0
            )
        });
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        reply(0);
        assert_eq!(step(0.0), OK);
        reply(1);
        assert_eq!(event().kind, 5);
    }
    #[test]
    fn item_invalidation_cancels_only_owned_walk_not_replacement_manual_route() {
        for revoked in [false, true] {
            for importing in [false, true] {
                let ids = items_fixture(1.0, 1);
                let source = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
                assert_eq!(queue_insert(0, source), OK);
                begin_source(source);
                if revoked {
                    assert_eq!(move_to(8.0, 8.0), OK);
                    assert_eq!(source_path_result(source), 2);
                }
                if importing {
                    assert_eq!(begin_actor_container_fixture(), OK);
                    let floor = container_next_id() as u32;
                    stage_floor_container_fixture(floor, 5, 5);
                    assert_eq!(
                        item_import_stage(ids[0], 0, floor, 5.0, 5.0, 100, 1, 0, 1.0, 1.0, 0, 1),
                        OK
                    );
                    assert_eq!(item_import_commit(), OK);
                } else {
                    assert_eq!(item_definition_begin(1), OK);
                    assert_eq!(item_definition_rollback(1), OK);
                }
                assert_eq!(queue_length(), 0);
                ENGINE.with(|e| {
                    let e = e.borrow();
                    if revoked {
                        assert_eq!(
                            (e.action, e.target_x, e.target_y),
                            (ACTION_DESTINATION, 8.0, 8.0)
                        );
                    } else {
                        assert_eq!((e.action, e.target_x, e.target_y), (ACTION_IDLE, e.x, e.y));
                    }
                });
            }
        }
    }
    #[test]
    fn revoked_walk_stream_restore_preserves_same_or_different_manual_route_and_cancels_follow_on()
    {
        for destination in [(6.5, 5.5), (8.0, 8.0)] {
            let ids = items_fixture(1.0, 1);
            let source = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
            assert_eq!(queue_insert(0, source), OK);
            begin_source(source);
            enqueue_source_grab(ids[0], 1.0);
            assert_eq!(move_to(destination.0, destination.1), OK);
            assert_eq!(source_path_result(source), 2);
            assert!(queue_save_size() > 0);
            let bytes = SAVED.with(|s| s.borrow().clone());
            state_save(scratch_ptr().cast());
            assert_eq!(state_load(scratch_ptr().cast()), OK); // Actual actor replacement precedes queue restore.
            assert_eq!(queue_length(), 0);
            assert_eq!(stage_bytes(&bytes), OK);
            assert_eq!(source_path_result(source), 2);
            ENGINE.with(|e| {
                let e = e.borrow();
                assert_eq!(
                    (e.action, e.target_x as f64, e.target_y as f64),
                    (ACTION_DESTINATION, destination.0, destination.1)
                );
            });
            let mut bad_owner = bytes.clone();
            bad_owner[36..40].copy_from_slice(&u32::MAX.to_le_bytes());
            assert_eq!(stage_bytes(&bad_owner), BAD_FORMAT);
            assert_eq!(source_path_result(source), 2);
            assert_eq!(step(0.0), OK);
            reply(1);
            assert_eq!(event().kind, 4);
            assert_eq!(queue_action_set(source, 4, 1.0), OK);
            reply(0);
            assert_eq!(event().kind, 6);
            assert_eq!(source_path_cancel(), OK);
            assert_eq!(queue_clear(), OK);
            reply(0);
            assert_eq!(queue_length(), 0);
            assert!(item(ids[0]).unwrap().world_object);
            assert_eq!(action(), ACTION_DESTINATION);
        }
    }
    fn restore_event_counters(next_token: u32, generation: u32) {
        assert!(queue_save_size() > 0);
        let mut bytes = SAVED.with(|s| s.borrow().clone());
        bytes[20..24].copy_from_slice(&generation.to_le_bytes());
        bytes[24..28].copy_from_slice(&next_token.to_le_bytes());
        assert_eq!(stage_bytes(&bytes), OK);
    }
    fn assert_retired_queue() {
        assert_eq!(queue_length(), 0);
        assert_eq!(queue_current(), 0);
        assert_eq!(queue_event_read(), 0);
        STORE.with(|s| {
            let s = s.borrow();
            assert!(s.actions.is_empty());
            assert!(s.groups.is_empty());
            assert_eq!((s.deferred, s.retrigger, s.path_owner), (0, 0, 0));
            assert!(!s.canceling);
            assert!(!s.preserve_movement);
        });
    }
    #[test]
    fn exhausted_source_begin_surfaces_failure_without_undoing_sdk_prefix_or_manual_route() {
        for next_token in [u32::MAX - 1, u32::MAX] {
            let ids = items_fixture(1.0, 2);
            assert_eq!(move_to(8.0, 8.0), OK);
            let sdk = queue_request_pickup(ids[0]) as u32;
            let source = enqueue_source_grab(ids[1], 20.0);
            assert_eq!(queue_action_set(sdk, 0, 0.0), OK);
            restore_event_counters(next_token, 0);
            if next_token == u32::MAX - 1 {
                assert_eq!(step(0.0), OK);
                let e = event();
                assert_eq!((e.action, e.kind, e.token), (source, 7, u32::MAX - 1));
                assert_eq!(queue_start(source, 35.0, 1), OK);
                assert_eq!(queue_event_reply(source, 7, e.token, 0), OUT_OF_RANGE);
            } else {
                assert_eq!(step(0.0), OUT_OF_RANGE);
            }
            assert_retired_queue();
            assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
            assert!(item(ids[1]).unwrap().world_object);
            ENGINE.with(|e| {
                let e = e.borrow();
                assert_eq!(
                    (e.action, e.target_x, e.target_y),
                    (ACTION_DESTINATION, 8.0, 8.0)
                );
            });
            assert!(queue_save_size() > 0);
            let exhausted = SAVED.with(|s| s.borrow().clone());
            assert_eq!(stage_bytes(&exhausted), OK);
            STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
            let later_sdk = queue_request_pickup(ids[1]);
            assert!(later_sdk > source as i32);
            assert_eq!(queue_action_set(later_sdk as u32, 0, 0.0), OK);
            assert_eq!(step(0.0), OK);
            assert_eq!(item(ids[1]).unwrap().owner_container, PLAYER_INVENTORY);
            STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
        }
    }
    #[test]
    fn exhausted_validate_wait_and_start_abort_without_leaking_owned_path_or_wrapping_generation() {
        for (next_token, generation, start) in [
            (u32::MAX - 1, 0, false),
            (u32::MAX - 2, 0, true),
            (1, u32::MAX - 1, false),
        ] {
            // Each boundary case needs a fresh native TLS store: reset preserves exhausted counters.
            std::thread::spawn(move || {
                crate::reset();
                let source = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
                assert_eq!(queue_insert(0, source), OK);
                restore_event_counters(next_token, generation);
                assert_eq!(queue_start(source, -1.0, 1), OK);
                let validate = event();
                assert_eq!(validate.kind, 1);
                if start {
                    reply(1);
                    let wait = event();
                    assert_eq!((wait.kind, wait.token), (2, u32::MAX - 1));
                    assert_eq!(queue_event_reply(source, 2, wait.token, 0), OUT_OF_RANGE);
                } else {
                    assert_eq!(
                        queue_event_reply(source, 1, validate.token, 1),
                        OUT_OF_RANGE
                    );
                }
                assert_retired_queue();
                assert_eq!(action(), ACTION_IDLE);
                assert!(queue_save_size() > 0);
                let bytes = SAVED.with(|s| s.borrow().clone());
                assert_eq!(stage_bytes(&bytes), OK);
                STORE.with(|s| {
                    let s = s.borrow();
                    if generation != 0 {
                        assert_eq!((s.generation, s.next_token), (u32::MAX, 2));
                    } else {
                        assert_eq!(s.next_token, u32::MAX);
                    }
                });
            })
            .join()
            .unwrap();
        }
    }
    #[test]
    fn exhausted_update_or_completion_event_never_acknowledges_a_dropped_callback_or_transfers_item()
     {
        for (remaining, stop) in [(1, false), (2, false), (2, true)] {
            // A previous exhausted store cannot accept another Source BEGIN.
            std::thread::spawn(move || {
                let ids = items_fixture(1.0, 1);
                let source = enqueue_source_grab(ids[0], 1.0);
                begin_source(source);
                restore_event_counters(u32::MAX - remaining, 0);
                assert_eq!(step(0.0), OK);
                let validate = event();
                assert_eq!(validate.kind, 1);
                if remaining == 1 {
                    assert_eq!(
                        queue_event_reply(source, 1, validate.token, 1),
                        OUT_OF_RANGE
                    );
                } else {
                    reply(1);
                    let update = event();
                    assert_eq!((update.kind, update.token), (4, u32::MAX - 1));
                    assert_eq!(queue_action_set(source, if stop { 4 } else { 3 }, 1.0), OK);
                    assert_eq!(queue_event_reply(source, 4, update.token, 0), OUT_OF_RANGE);
                }
                assert_retired_queue();
                assert!(item(ids[0]).unwrap().world_object);
                STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
            })
            .join()
            .unwrap();
        }
    }
    #[test]
    fn exhausted_deferred_begin_keeps_source_perform_committed_prefix_and_retires_continuation() {
        let ids = items_fixture(1.0, 1);
        let source = enqueue_source_grab(ids[0], 1.0);
        begin_source(source);
        let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(1, next), OK);
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        restore_event_counters(u32::MAX - 2, 0);
        assert_eq!(step(0.0), OK);
        reply(1);
        let perform = event();
        assert_eq!((perform.kind, perform.token), (5, u32::MAX - 1));
        let group = queue_group_get(source, 0) as u32;
        assert_eq!(queue_commit_item(source, group, ids[0], perform.token), OK);
        assert_eq!(queue_remove(0), source as i32);
        assert_eq!(queue_start(next, -1.0, 1), OK);
        assert_eq!(queue_event_reply(source, 5, perform.token, 0), OUT_OF_RANGE);
        assert_retired_queue();
        assert_eq!(item(ids[0]).unwrap().owner_container, PLAYER_INVENTORY);
        assert_eq!(
            queue_commit_item(source, group, ids[0], perform.token),
            OUT_OF_RANGE
        );
        STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
    }
    #[test]
    fn exhausted_frame_wait_start_completion_propagates_perform_allocation_failure() {
        crate::reset();
        let source = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, source), OK);
        assert_eq!(queue_start(source, -1.0, 1), OK);
        reply(1);
        reply(1);
        assert_eq!(queue_event_read(), 0);
        restore_event_counters(u32::MAX - 3, 0);
        assert_eq!(frame_step(0.0), OK);
        reply(1);
        reply(0);
        let start = event();
        assert_eq!(
            (start.kind, start.token, start.frame),
            (3, u32::MAX - 1, true)
        );
        assert_eq!(queue_action_set(source, 3, 1.0), OK);
        assert_eq!(queue_event_reply(source, 3, start.token, 0), OUT_OF_RANGE);
        assert_retired_queue();
    }
    #[test]
    fn exhausted_frame_remove_and_explicit_begin_surface_failure_and_clear_unstarted_head() {
        for consumer in 0..4 {
            crate::reset();
            let source = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
            assert_eq!(queue_insert(0, source), OK);
            if consumer == 2 {
                let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
                assert_eq!(queue_insert(1, next), OK);
            }
            restore_event_counters(u32::MAX, 0);
            let status = match consumer {
                0 => step(0.0),
                1 => frame_step(0.0),
                2 => queue_remove(0),
                _ => queue_start(source, -1.0, 1),
            };
            assert_eq!(status, OUT_OF_RANGE);
            assert_retired_queue();
            STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
        }
    }
    #[test]
    fn exhausted_stop_reports_failure_but_only_cancels_owned_movement_until_void_hard_cancel() {
        crate::reset();
        let source = queue_action_new(1, 1, 0, 6, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, source), OK);
        begin_source(source);
        restore_event_counters(u32::MAX, 0);
        assert_eq!(queue_clear(), OUT_OF_RANGE);
        assert_retired_queue();
        assert_eq!(action(), ACTION_IDLE);
        crate::cancel();
        assert_retired_queue();
        assert_eq!(action(), ACTION_IDLE);
        for destination in [true, false] {
            // The owned-path case exhausted this thread's store; use a fresh native instance.
            std::thread::spawn(move || {
                let ids = items_fixture(1.0, 1);
                let source = enqueue_source_grab(ids[0], 1.0);
                begin_source(source);
                restore_event_counters(u32::MAX, 0);
                if destination {
                    assert_eq!(move_to(8.0, 8.0), OUT_OF_RANGE);
                    ENGINE.with(|e| {
                        let e = e.borrow();
                        assert_eq!(
                            (e.action, e.target_x, e.target_y),
                            (ACTION_DESTINATION, 8.0, 8.0)
                        );
                    });
                } else {
                    assert_eq!(walk(1.0, 0.0), OUT_OF_RANGE);
                    ENGINE.with(|e| {
                        let e = e.borrow();
                        assert_eq!(
                            (e.action, e.heading_x, e.heading_y),
                            (ACTION_WALKING, 1.0, 0.0)
                        );
                    });
                }
                assert_retired_queue();
                assert!(item(ids[0]).unwrap().world_object);
                crate::cancel();
                assert_retired_queue();
                assert_eq!(action(), ACTION_IDLE);
                STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
            })
            .join()
            .unwrap();
        }
    }
    #[test]
    fn source_stop_reset_preserves_unstarted_callback_token_and_void_cancel_never_duplicates_stop()
    {
        for started in [false, true] {
            let ids = items_fixture(1.0, 1);
            let source = enqueue_source_grab(ids[0], 1.0);
            if started {
                begin_source(source);
                assert_eq!(queue_clear(), OK);
            } else {
                assert_eq!(queue_start(source, 1.0, 1), OK);
                reply(0);
            }
            let stop = event();
            assert_eq!(stop.kind, 6);
            assert_eq!(queue_clear(), OK);
            crate::cancel();
            let retained = event();
            assert_eq!(
                (
                    retained.action,
                    retained.kind,
                    retained.token,
                    retained.generation
                ),
                (source, 6, stop.token, stop.generation)
            );
            assert_eq!(queue_current(), source as i32);
            assert_eq!(queue_length(), 0);
            STORE.with(|s| {
                let s = s.borrow();
                let a = s.action(source).unwrap();
                assert_eq!(a.flags & STARTED, if started { STARTED } else { 0 });
                assert_eq!(a.current, if started { 0.0 } else { -2.0 });
                assert_eq!(s.next_token, stop.token + 1);
            });
            assert_eq!(queue_event_reply(source, 6, stop.token, 0), OK);
            assert_retired_queue();
            assert_eq!(queue_event_reply(source, 6, stop.token, 0), OUT_OF_RANGE);
            assert!(item(ids[0]).unwrap().world_object);
        }
    }
    #[test]
    fn exhausted_stop_reply_surfaces_deferred_begin_failure_without_starting_replacement() {
        let ids = items_fixture(1.0, 1);
        let source = enqueue_source_grab(ids[0], 1.0);
        begin_source(source);
        restore_event_counters(u32::MAX - 1, 0);
        assert_eq!(queue_clear(), OK);
        let stop = event();
        assert_eq!((stop.kind, stop.token), (6, u32::MAX - 1));
        let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
        assert_eq!(queue_insert(0, next), OK);
        assert_eq!(queue_start(next, -1.0, 1), OK);
        assert_eq!(queue_event_reply(source, 6, stop.token, 0), OUT_OF_RANGE);
        assert_retired_queue();
        assert!(item(ids[0]).unwrap().world_object);
        STORE.with(|s| assert_eq!(s.borrow().next_token, u32::MAX));
    }
    #[test]
    fn broken_queued_item_refuses_capture_without_mutating_queue_then_real_failure_cleanup_restores()
     {
        for broken in [0, 1] {
            crate::reset();
            assert_eq!(
                item_definition_register(0, 1, 100, 0, 1, 1, 0, 0, 1.0, 0),
                OK
            );
            let ids: Vec<u32> = (0..2)
                .map(|_| {
                    assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OK);
                    item_last_id()
                })
                .collect();
            let id = queue_request_pickup(ids[0]) as u32;
            assert_eq!(queue_request_pickup(ids[1]), id as i32);
            assert_eq!(queue_action_set(id, 0, 0.0), OK);
            assert!(queue_save_size() > 0);
            assert_eq!(queue_action_read(id), OK);
            let before = QUEUE_SCRATCH.with(|s| s.borrow()[..16].to_vec());
            let clock = timing::snapshot_words();
            let group = queue_group_get(id, 0) as u32;
            assert_eq!(item_set_condition(ids[broken], 0), OK);
            assert!(item(ids[broken]).is_none());
            assert_eq!(queue_save_size(), OUT_OF_RANGE);
            assert_eq!(queue_current(), id as i32);
            assert_eq!(queue_length(), 1);
            assert_eq!(queue_group_item_length(group), 2);
            assert_eq!(queue_group_item_get(group, 0), ids[0] as f64);
            assert_eq!(queue_group_item_get(group, 1), ids[1] as f64);
            assert_eq!(queue_action_read(id), OK);
            assert_eq!(QUEUE_SCRATCH.with(|s| s.borrow()[..16].to_vec()), before);
            assert_eq!(timing::snapshot_words(), clock);
            assert!(item(ids[1 - broken]).unwrap().world_object);
            assert_eq!(step(0.0), OK);
            assert_retired_queue();
            assert_eq!(item(ids[1 - broken]).unwrap().world_object, broken == 0);
            assert!(item(ids[broken]).is_none());
            assert!(queue_save_size() > 0);
            let bytes = SAVED.with(|s| s.borrow().clone());
            assert_eq!(stage_bytes(&bytes), OK);
            assert_retired_queue();
        }
    }
    #[test]
    fn broken_source_target_capture_refusal_keeps_original_stop_lifecycle_available() {
        crate::reset();
        assert_eq!(
            item_definition_register(0, 1, 100, 0, 1, 1, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OK);
        let item_id = item_last_id();
        let source = enqueue_source_grab(item_id, 20.0);
        begin_source(source);
        assert_eq!(item_set_condition(item_id, 0), OK);
        assert_eq!(queue_save_size(), OUT_OF_RANGE);
        assert_eq!(queue_current(), source as i32);
        assert_eq!(queue_length(), 1);
        assert_eq!(queue_event_read(), 0);
        assert_eq!(step(0.0), OK);
        assert_eq!(event().kind, 1);
        reply(0);
        assert_eq!(event().kind, 6);
        assert_eq!(queue_clear(), OK);
        reply(0);
        assert_retired_queue();
        assert!(item(item_id).is_none());
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(stage_bytes(&bytes), OK);
    }
    #[test]
    fn second_explicit_clear_cancels_deferred_replacement_without_poisoning_live_stop_reply() {
        for (consumer, started) in [
            (0, false),
            (0, true),
            (1, false),
            (1, true),
            (2, false),
            (2, true),
        ] {
            crate::reset();
            let old = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
            assert_eq!(queue_insert(0, old), OK);
            if started {
                begin_source(old);
            } else {
                assert_eq!(queue_start(old, -1.0, 1), OK);
                reply(0);
            }
            assert_eq!(queue_clear(), OK);
            let stop = event();
            assert_eq!(stop.kind, 6);
            let next = queue_action_new(4, 1, u32::MAX, 5, 5, 0, -1.0) as u32;
            assert_eq!(queue_insert(0, next), OK);
            assert_eq!(queue_start(next, 17.5, 1), OK);
            STORE.with(|s| assert_eq!(s.borrow().deferred, next));
            match consumer {
                0 => assert_eq!(queue_clear(), OK),
                1 => crate::cancel(),
                _ => assert_eq!(queue_remove(0), next as i32),
            }
            let retained = event();
            assert_eq!(
                (
                    retained.action,
                    retained.kind,
                    retained.token,
                    retained.generation
                ),
                (old, 6, stop.token, stop.generation)
            );
            assert_eq!(queue_length(), 0);
            assert_eq!(queue_action_read(next), OUT_OF_RANGE);
            STORE.with(|s| {
                let s = s.borrow();
                assert_eq!(s.deferred, 0);
                assert_eq!(s.next_token, stop.token + 1);
            });
            assert_eq!(queue_event_reply(old, 6, stop.token, 0), OK);
            assert_retired_queue();
            assert_eq!(queue_event_reply(old, 6, stop.token, 0), OUT_OF_RANGE);
        }
    }
    #[test]
    fn source_group_staging_remains_live_but_capture_requires_complete_restorable_membership() {
        let ids = items_fixture(1.0, 1);
        let source = queue_action_new(3, 1, ids[0], 5, 5, 0, 20.0) as u32;
        assert_eq!(queue_insert(0, source), OK);
        assert_eq!(queue_save_size(), OUT_OF_RANGE);
        assert_eq!(queue_get(0), source as i32);
        assert!(item(ids[0]).unwrap().world_object);
        let group = queue_group_new(source, 20.0) as u32;
        assert_eq!(queue_group_insert(source, 0, group), OK);
        assert_eq!(queue_save_size(), OUT_OF_RANGE);
        assert_eq!(queue_group_item_length(group), 0);
        assert_eq!(queue_group_item_insert(group, 0, ids[0]), OK);
        assert!(queue_save_size() > 0);
        let bytes = SAVED.with(|s| s.borrow().clone());
        assert_eq!(stage_bytes(&bytes), OK);
        assert_eq!(queue_get(0), source as i32);
        assert_eq!(queue_group_item_get(group, 0), ids[0] as f64);
        assert_eq!(queue_current(), 0);
        assert_eq!(queue_event_read(), 0);
    }
}

use super::*;
use std::collections::HashSet;
// ponytail: explicit source-port ceilings; increase only with a real workload.
const ACTIONS: usize = 128;
const GROUPS: usize = 512;
const GROUP_ITEMS: usize = 20;
const PAYLOAD: usize = 1024 * 1024;
const STARTED: u32 = 1;
const COMPLETE: u32 = 2;
const STOP: u32 = 4;
const LOOP: u32 = 8;
const WALK: u32 = 16;
const RUN: u32 = 32;
const AIM: u32 = 64;
const WAIT: u32 = 128;
const SOURCE_GRAB_STARTED: u32 = 256;
const ALLOW_MISSING: u32 = 1024;
fn transfer_kind(kind: u32) -> bool {
    kind == 3 || kind == 5
}

#[derive(Clone)]
struct Action {
    id: u32,
    kind: u32,
    origin: u32,
    target: u32,
    xyz: (i32, i32, i32),
    source_container: u32,
    destination_container: u32,
    raw: f64,
    source_time: f64,
    max: i32,
    current: f32,
    last: f32,
    prev: f32,
    delta: f32,
    flags: u32,
    portable: bool,
    groups: Vec<u32>,
}
impl Action {
    fn new(id: u32, kind: u32, origin: u32, target: u32, xyz: (i32, i32, i32), raw: f64) -> Self {
        Self {
            id,
            kind,
            origin,
            target,
            xyz,
            source_container: if kind == 3 {
                item(target).map_or(0, |i| i.owner_container)
            } else {
                0
            },
            destination_container: if kind == 3 { PLAYER_INVENTORY } else { 0 },
            raw,
            source_time: raw,
            max: raw as i32,
            current: -2.0,
            last: -1.0,
            prev: 0.0,
            delta: 0.0,
            flags: if transfer_kind(kind) {
                WALK | RUN | LOOP
            } else {
                0
            },
            portable: true,
            groups: if transfer_kind(kind) {
                Vec::with_capacity(GROUPS)
            } else {
                Vec::new()
            },
        }
    }
    fn reset_progress(&mut self) {
        self.current = 0.0;
        self.delta = 0.0;
    }
    fn finished(&self) -> bool {
        self.flags & COMPLETE != 0
            || (self.flags & WAIT == 0 && self.max != -1 && self.current >= self.max as f32)
    }
    fn advance(&mut self, multiplier: f32) {
        self.prev = self.last;
        self.last = self.current;
        self.current += multiplier;
        if self.current < 0.0 {
            self.current = 0.0;
        }
        if self.max != -1 {
            self.delta = if self.max == 0 {
                0.0
            } else {
                let ratio = self.current / self.max as f32;
                if ratio.is_nan() {
                    ratio
                } else {
                    ratio.min(1.0)
                }
            };
        }
    }
}
#[derive(Clone)]
struct Group {
    id: u32,
    action: u32,
    raw: f64,
    definition: Option<u32>,
    items: Vec<u32>,
    sources: [u32; GROUP_ITEMS],
}
#[derive(Clone, Copy)]
struct Event {
    action: u32,
    kind: u32,
    generation: u32,
    token: u32,
    frame: bool,
    committed_door: bool,
    group: u32,
    authorized: [u32; GROUP_ITEMS],
    authorized_sources: [u32; GROUP_ITEMS],
    authorized_count: usize,
    consumed: [u32; GROUP_ITEMS],
    consumed_count: usize,
    begin_supplied: bool,
}

struct TransferTransaction {
    action: u32,
    token: u32,
    item: Item,
    index: usize,
    held: [u32; 2],
    worn_index: Option<usize>,
    source: u32,
    destination: u32,
    detached: bool,
    added: bool,
    actor_overlay: u32,
    attached_index: Option<usize>,
    rng_state: u64,
    container_flags: [u32; 2],
}
struct Store {
    actions: Vec<Action>,
    fifo: Vec<u32>,
    groups: Vec<Group>,
    current: u32,
    next_action: u32,
    next_group: u32,
    generation: u32,
    next_token: u32,
    event: Option<Event>,
    deferred: u32,
    canceling: bool,
    preserve_movement: bool,
    retrigger: u32,
    path_owner: u32,
    transfer: Option<TransferTransaction>,
}
impl Store {
    fn new() -> Self {
        Self {
            actions: Vec::with_capacity(ACTIONS),
            fifo: Vec::with_capacity(ACTIONS),
            groups: Vec::with_capacity(GROUPS),
            current: 0,
            next_action: 1,
            next_group: 1,
            generation: 0,
            next_token: 1,
            event: None,
            deferred: 0,
            canceling: false,
            preserve_movement: false,
            retrigger: 0,
            path_owner: 0,
            transfer: None,
        }
    }
    fn rollback_transfer(&mut self) {
        let Some(transaction) = self.transfer.take() else {
            return;
        };
        // PORT SAFETY: original removes first; restore ownership on failed helper.
        ITEMS.with(|state| {
            let mut state = state.borrow_mut();
            if let Some(index) = state
                .live
                .iter()
                .position(|item| item.id == transaction.item.id)
            {
                state.live.remove(index);
            }
            let index = transaction.index.min(state.live.len());
            state.live.insert(index, transaction.item);
            state.attached.retain(|id| *id != transaction.item.id);
            if let Some(index) = transaction.attached_index {
                let index = index.min(state.attached.len());
                state.attached.insert(index, transaction.item.id);
            }
            state.held = transaction.held;
            state.worn.retain(|id| *id != transaction.item.id);
            if let Some(index) = transaction.worn_index {
                let index = index.min(state.worn.len());
                state.worn.insert(index, transaction.item.id);
            }
            state.actor_overlay = transaction.actor_overlay;
            for (id, flags) in [
                (transaction.source, transaction.container_flags[0]),
                (transaction.destination, transaction.container_flags[1]),
            ] {
                if let Some(row) = state.containers.iter_mut().find(|row| row.id == id) {
                    row.flags = flags;
                }
            }
            state.source_transfer = false;
        });
        doors::restore_rng(transaction.rng_state);
    }
    fn action(&self, id: u32) -> Option<&Action> {
        self.actions.iter().find(|a| a.id == id)
    }
    fn action_mut(&mut self, id: u32) -> Option<&mut Action> {
        self.actions.iter_mut().find(|a| a.id == id)
    }
    fn group(&self, id: u32) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }
    fn group_mut(&mut self, id: u32) -> Option<&mut Group> {
        self.groups.iter_mut().find(|g| g.id == id)
    }
    fn new_action(
        &mut self,
        kind: u32,
        origin: u32,
        target: u32,
        xyz: (i32, i32, i32),
        raw: f64,
    ) -> Result<u32, i32> {
        if !(1..=5).contains(&kind)
            || origin > 1
            || (kind == 4 && origin != 1)
            || self.actions.len() == ACTIONS
            || self.next_action > i32::MAX as u32
        {
            return Err(OUT_OF_RANGE);
        }
        let id = self.next_action;
        self.next_action += 1;
        self.actions
            .push(Action::new(id, kind, origin, target, xyz, raw));
        Ok(id)
    }
    fn new_group(&mut self, action: u32, raw: f64) -> Result<u32, i32> {
        if self.action(action).is_none_or(|a| !transfer_kind(a.kind))
            || self.groups.len() == GROUPS
            || self.next_group > i32::MAX as u32
        {
            return Err(OUT_OF_RANGE);
        }
        let id = self.next_group;
        self.next_group += 1;
        self.groups.push(Group {
            id,
            action,
            raw,
            definition: None,
            items: Vec::with_capacity(GROUP_ITEMS),
            sources: [0; GROUP_ITEMS],
        });
        Ok(id)
    }
    fn retire(&mut self, id: u32) {
        self.fifo.retain(|v| *v != id);
        self.actions.retain(|a| a.id != id);
        self.groups.retain(|g| g.action != id);
        if self.current == id {
            self.current = 0;
        }
        if self.retrigger == id {
            self.retrigger = 0;
        }
        if self.deferred == id {
            self.deferred = 0;
        }
        if self.path_owner == id {
            self.path_owner = 0;
        }
    }
    fn tail_square(&self) -> (i32, i32, i32) {
        self.fifo
            .iter()
            .rev()
            .filter_map(|id| self.action(*id))
            .find(|a| a.kind == 1)
            .map_or_else(actor_square, |a| a.xyz)
    }
    fn emit(&mut self, id: u32, kind: u32, frame: bool) -> i32 {
        if self.event.is_some() || self.next_token == u32::MAX || self.generation == u32::MAX {
            self.abort();
            return OUT_OF_RANGE;
        }
        self.generation += 1;
        let group = if kind == 5 {
            self.action(id)
                .and_then(|a| a.groups.first())
                .copied()
                .unwrap_or(0)
        } else {
            0
        };
        let mut authorized = [0; GROUP_ITEMS];
        let mut authorized_sources = [0; GROUP_ITEMS];
        let authorized_count = self.group(group).map_or(0, |g| g.items.len());
        if let Some(g) = self.group(group) {
            authorized[..authorized_count].copy_from_slice(&g.items);
            authorized_sources[..authorized_count].copy_from_slice(&g.sources[..authorized_count]);
        }
        self.event = Some(Event {
            action: id,
            kind,
            generation: self.generation,
            token: self.next_token,
            frame,
            committed_door: false,
            group,
            authorized,
            authorized_sources,
            authorized_count,
            consumed: [0; GROUP_ITEMS],
            consumed_count: 0,
            begin_supplied: false,
        });
        self.next_token += 1;
        OK
    }
    fn abort(&mut self) {
        self.rollback_transfer();
        let cancel_owned_path = self.path_owner != 0;
        self.actions.clear();
        self.fifo.clear();
        self.groups.clear();
        self.current = 0;
        self.event = None;
        self.deferred = 0;
        self.retrigger = 0;
        self.path_owner = 0;
        self.canceling = false;
        self.preserve_movement = false;
        if cancel_owned_path {
            clear_world_path();
            mutate(|engine| engine.cancel());
        }
    }
    fn start_eligible(&self, id: u32) -> bool {
        self.action(id).is_some()
            && self.fifo.first().copied() == Some(id)
            && self
                .event
                .is_none_or(|e| e.action != id && (e.kind == 5 || e.kind == 6))
    }
    fn begin(&mut self, id: u32) -> i32 {
        let Some(a) = self.action(id) else {
            return OUT_OF_RANGE;
        };
        let max = if a.origin == 0 {
            adjusted(a.raw)
        } else {
            a.max
        };
        self.begin_at(id, max)
    }
    fn begin_at(&mut self, id: u32, max: i32) -> i32 {
        if !self.start_eligible(id) {
            return OUT_OF_RANGE;
        }
        let source = self.action(id).unwrap().origin == 1;
        if source
            && self.event.is_none()
            && (self.next_token == u32::MAX || self.generation == u32::MAX)
        {
            self.abort();
            return OUT_OF_RANGE;
        }
        if !source && !valid_action(self.action(id).unwrap()) {
            self.abort();
            return BLOCKED;
        }
        self.action_mut(id).unwrap().max = max;
        if self.event.is_some() {
            self.deferred = id;
            return OK;
        }
        self.current = id;
        if source {
            self.emit(id, 1, false)
        } else {
            self.start_native(id)
        }
    }
    fn start_native(&mut self, id: u32) -> i32 {
        let a = self.action_mut(id).unwrap();
        a.flags = (a.flags | STARTED) & !(COMPLETE | STOP);
        a.current = 0.0;
        if a.kind == 1 {
            let status = move_to_internal(a.xyz.0 as f64 + 0.5, a.xyz.1 as f64 + 0.5);
            if status != OK {
                self.abort();
                return status;
            }
            self.path_owner = id;
        }
        OK
    }
    fn begin_head(&mut self) -> i32 {
        if self.current == 0
            && self.event.is_none()
            && let Some(id) = self.fifo.first().copied()
        {
            if self.action(id).is_some_and(|a| a.origin == 1) {
                // Eligibility is not BEGIN: the resident original must create
                // and supply its adjusted duration before native validation.
                let status = self.emit(id, 7, false);
                if status == OK {
                    self.current = id;
                }
                return status;
            } else {
                return self.begin(id);
            }
        }
        OK
    }
    fn finish_sdk(&mut self, id: u32) -> i32 {
        let kind = self.action(id).unwrap().kind;
        if kind == 2 {
            if mutation_allowed() {
                doors::commit_toggle(self.action(id).unwrap().target);
            }
            self.retire(id);
        } else if transfer_kind(kind) {
            let Some(gid) = self.action(id).unwrap().groups.first().copied() else {
                self.retire(id);
                return OK;
            };
            // Per-item source revalidation preserves a successfully transferred prefix.
            let group_index = self.groups.iter().position(|g| g.id == gid).unwrap();
            let len = self.groups[group_index].items.len();
            if len == 0 {
                self.abort();
                return OK;
            }
            let mut failed = false;
            for index in 0..len {
                let item = self.groups[group_index].items[index];
                let action = self.action(id).unwrap();
                if transfer(
                    item,
                    self.groups[group_index].sources[index],
                    action.destination_container,
                ) != OK
                {
                    failed = true;
                    break;
                }
            }
            self.action_mut(id).unwrap().groups.remove(0);
            self.groups.retain(|g| g.id != gid);
            if failed || self.action(id).unwrap().groups.is_empty() {
                self.retire(id);
            } else {
                let next = self.action(id).unwrap().groups[0];
                let group = self.group(next).unwrap();
                let raw = group.raw;
                let Some(target) = group.items.first().copied() else {
                    self.abort();
                    return OK;
                };
                let Some(next_item) = item(target) else {
                    self.retire(id);
                    return self.begin_head();
                };
                let xyz = (next_item.x.floor() as i32, next_item.y.floor() as i32, 0);
                let a = self.action_mut(id).unwrap();
                a.target = target;
                if a.kind == 3 {
                    a.source_container = next_item.owner_container;
                    a.xyz = xyz;
                }
                a.max = raw as i32;
                a.source_time = raw;
                a.reset_progress();
            }
        } else {
            if self.path_owner == id {
                clear_world_path();
                mutate(|engine| engine.cancel());
            }
            self.retire(id);
        }
        self.begin_head()
    }
    fn source_completion(&mut self, id: u32, frame: bool) -> i32 {
        let Some(a) = self.action(id) else {
            return OK;
        };
        // Character update performs completion before processing force-stop.
        if a.finished() {
            self.emit(id, 5, frame)
        } else if a.flags & STOP != 0 {
            self.emit(id, 6, frame)
        } else {
            OK
        }
    }
    fn frame_valid(&mut self, id: u32) -> i32 {
        let Some(a) = self.action(id) else {
            return OK;
        };
        if a.origin == 1 {
            if a.flags & STARTED == 0 {
                return self.emit(id, 2, true);
            }
            if !a.finished() && a.flags & STOP == 0 {
                self.action_mut(id).unwrap().advance(timing::multiplier());
                return self.emit(id, 4, true);
            } else {
                return self.source_completion(id, true);
            }
        }
        if a.finished() {
            return self.finish_sdk(id);
        }
        if a.flags & STOP != 0 {
            self.abort();
            return OK;
        }
        if a.flags & STARTED == 0 {
            return self.start_native(id);
        }
        if a.kind == 1 {
            if self.path_owner != id {
                self.abort();
                return OK;
            }
            self.action_mut(id).unwrap().advance(timing::multiplier());
            if action() != ACTION_IDLE {
                return OK;
            }
            let a = self.action(id).unwrap();
            let reached =
                ENGINE.with(|e| e.borrow().is_at(a.xyz.0 as f32 + 0.5, a.xyz.1 as f32 + 0.5));
            if reached {
                return self.finish_sdk(id);
            } else {
                self.abort();
                return OK;
            }
        }
        self.action_mut(id).unwrap().advance(timing::multiplier());
        if self.action(id).is_some_and(Action::finished) {
            return self.finish_sdk(id);
        }
        OK
    }
}
thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store::new());
    static QUEUE_SCRATCH: RefCell<[u64;512]> = const { RefCell::new([0;512]) };
    static SAVED: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESTORE: RefCell<Option<(Vec<u8>,usize)>> = const { RefCell::new(None) };
    static POSTURE: RefCell<bool> = const { RefCell::new(false) };
}
pub(super) fn row(values: &[f64]) {
    QUEUE_SCRATCH.with(|scratch| {
        let mut scratch = scratch.borrow_mut();
        for (index, value) in values.iter().enumerate() {
            scratch[index] = value.to_bits();
        }
    });
}
fn items_available() -> bool {
    ITEMS.with(|items| {
        let items = items.borrow();
        !items.importing && !items.source_transfer && items.transaction_owner == 0
    })
}
fn mutation_allowed() -> bool {
    health() > 0.0 && items_available()
}
fn actor_square() -> (i32, i32, i32) {
    (position_x().floor() as i32, position_y().floor() as i32, 0)
}
fn item(id: u32) -> Option<Item> {
    ITEMS.with(|items| items.borrow().live.iter().find(|i| i.id == id).copied())
}
fn transfer_check(id: u32, source: u32, destination: u32, policy: i32) -> i32 {
    transfer_check_inner(id, source, destination, policy, true)
}
fn transfer_check_inner(
    id: u32,
    source: u32,
    destination: u32,
    policy: i32,
    admission: bool,
) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|state| {
        let state = state.borrow();
        if state.actor_turn_target != 0 || state.actor_furniture != 0 || state.actor_vehicle != 0 {
            return UNSUPPORTED;
        }
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        if source == destination
            || item.owner_container != source
            || state.container(source).is_none()
            || state.container(destination).is_none()
        {
            return OUT_OF_RANGE;
        }
        if state.definitions[item.definition as usize].graph_flags & 4 != 0 {
            return UNSUPPORTED;
        }
        if item.source_flags & 2 != 0 {
            return OUT_OF_RANGE;
        }
        if item.source_flags & 1 != 0
            && state.outermost(source) == Some(PLAYER_INVENTORY)
            && state.outermost(destination) != Some(PLAYER_INVENTORY)
        {
            return BLOCKED;
        }
        for container in [source, destination] {
            let root = state.outermost(container).unwrap();
            if let Some(row) = state.container(root).filter(|row| row.kind == 2)
                && doors::blocked_to(row.xyz, actor_square())
            {
                return BLOCKED;
            }
        }
        let allowed = if admission {
            state.has_room_item(destination, 1, item, policy)
        } else {
            state.item_allowed(destination, item, policy)
        };
        match allowed {
            Ok(true) if !state.inside(destination, id) => OK,
            Ok(_) => BLOCKED,
            Err(code) => code,
        }
    })
}
fn transfer(id: u32, source: u32, destination: u32) -> i32 {
    let status = transfer_check(id, source, destination, -1);
    if status != OK {
        return status;
    }
    change_item(id, |state, index| {
        let mut item = state.live.remove(index);
        item.owner_container = destination;
        item.world_object = state.container(destination).unwrap().kind == 2;
        if item.world_object {
            let xyz = state.container(destination).unwrap().xyz;
            item.x = xyz.0 as f64 + 0.5;
            item.y = xyz.1 as f64 + 0.5;
        }
        if destination != PLAYER_INVENTORY {
            item.slot = 0;
            state.clear_held(id);
            state.remove_worn(id);
        }
        state.live.push(item);
        OK
    })
}
fn valid_action(a: &Action) -> bool {
    if !mutation_allowed() {
        return false;
    }
    match a.kind {
        1 => a.xyz.2 == 0 && item_position_valid(a.xyz.0 as f64 + 0.5, a.xyz.1 as f64 + 0.5),
        2 => doors::reach_door(a.target, actor_square()),
        3 | 5 => transfer_check(a.target, a.source_container, a.destination_container, -1) == OK,
        4 => a.origin == 1 && (a.target == u32::MAX || doors::position(a.target).is_some()),
        _ => false,
    }
}
fn adjusted(raw: f64) -> i32 {
    timing::adjust_initial(
        raw,
        moodle_level(6),
        moodle_level(21),
        std::array::from_fn(|i| body::body_part_value(i as u32, 16) as f32),
        body::thermal_action_modifier(),
    )
}
pub(super) fn invalidate() {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        s.rollback_transfer();
        if s.path_owner != 0 {
            mutate(|engine| engine.cancel());
        }
        s.actions.clear();
        s.groups.clear();
        s.fifo.clear();
        s.current = 0;
        s.event = None;
        s.deferred = 0;
        s.canceling = false;
        s.retrigger = 0;
        s.preserve_movement = false;
        s.path_owner = 0;
    });
    RESTORE.with(|s| *s.borrow_mut() = None);
    SAVED.with(|s| s.borrow_mut().clear());
}
pub(super) fn cancel_queue() -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        s.rollback_transfer();
        let id = s.current;
        if s.event.is_some_and(|e| e.kind == 5) && !s.fifo.contains(&id) {
            // Original completion callbacks may clear pending actions before
            // adding their continuation. Do not revoke the live perform token.
            s.fifo.clear();
            s.actions.retain(|a| a.id == id);
            s.groups.retain(|g| g.action == id);
            s.deferred = 0;
            return OK;
        }
        if s.path_owner == id && s.action(id).is_some_and(|a| a.kind == 1) && !s.preserve_movement {
            clear_world_path();
            mutate(|engine| engine.cancel());
        }
        if s.action(id).is_some_and(|a| {
            a.origin == 1
                && (a.flags & STARTED != 0
                    || s.event.is_some_and(|e| e.action == id && e.kind == 6))
        }) {
            s.fifo.clear();
            s.canceling = true;
            s.actions.retain(|a| a.id == id);
            s.groups.retain(|g| g.action == id);
            s.deferred = 0;
            if s.retrigger != id {
                s.retrigger = 0;
            }
            if s.event.is_none_or(|e| e.kind != 6) {
                s.event = None;
                return s.emit(id, 6, false);
            }
        } else {
            s.fifo.clear();
            s.actions.clear();
            s.groups.clear();
            s.current = 0;
            s.event = None;
            s.deferred = 0;
            s.retrigger = 0;
            s.preserve_movement = false;
            s.path_owner = 0;
        }
        OK
    })
}
pub(super) fn movement_requested() -> i32 {
    STORE.with(|s| s.borrow_mut().path_owner = 0);
    let stop = STORE.with(|s| {
        let s = s.borrow();
        s.action(s.current).is_some_and(|a| a.flags & WALK != 0)
    });
    if stop {
        STORE.with(|s| s.borrow_mut().preserve_movement = true);
        cancel_queue()
    } else {
        OK
    }
}
pub(super) fn frame() -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.event.is_some() {
            return OK;
        }
        let status = s.begin_head();
        if status != OK {
            return status;
        }
        if s.event.is_some() {
            return OK;
        }
        let id = s.current;
        let Some(a) = s.action(id) else {
            return OK;
        };
        if a.origin == 1 {
            s.emit(id, 1, true)
        } else if valid_action(a) {
            s.frame_valid(id)
        } else {
            s.abort();
            OK
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_capability() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_scratch_ptr() -> *mut u8 {
    QUEUE_SCRATCH.with(|s| s.as_ptr().cast())
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_scratch_size() -> u32 {
    4096
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_action_new(
    kind: u32,
    origin: u32,
    target_id: u32,
    x: i32,
    y: i32,
    z: i32,
    raw_time: f64,
) -> i32 {
    if !mutation_allowed() || z != 0 {
        return OUT_OF_RANGE;
    }
    let valid = match kind {
        1 => {
            target_id == 0
                && item_position_valid(x as f64 + 0.5, y as f64 + 0.5)
                && (!world_extents().0 || tile_passable(tile_at(x as i64, y as i64)))
        }
        2 => doors::position(target_id) == Some((x, y, z)),
        3 => item(target_id).is_some_and(|i| {
            i.world_object && (i.x.floor() as i32, i.y.floor() as i32, 0) == (x, y, z)
        }),
        4 => origin == 1 && (target_id == u32::MAX || doors::position(target_id).is_some()),
        5 => item(target_id).is_some(),
        _ => false,
    };
    if !valid {
        return OUT_OF_RANGE;
    }
    STORE.with(|s| {
        s.borrow_mut()
            .new_action(kind, origin, target_id, (x, y, z), raw_time)
            .map_or_else(|e| e, |id| id as i32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_action_read(id: u32) -> i32 {
    STORE.with(|s| {
        let s = s.borrow();
        let Some(a) = s.action(id) else {
            return OUT_OF_RANGE;
        };
        row(&[
            a.id as f64,
            a.kind as f64,
            a.origin as f64,
            a.target as f64,
            a.xyz.0 as f64,
            a.xyz.1 as f64,
            a.xyz.2 as f64,
            a.raw,
            a.max as f64,
            a.current as f64,
            a.last as f64,
            a.prev as f64,
            a.delta as f64,
            a.flags as f64,
            a.groups.len() as f64,
            u32::from(a.portable) as f64,
        ]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_action_set(id: u32, field: u32, value: f64) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(a) = s.action_mut(id) else {
            return OUT_OF_RANGE;
        };
        match field {
            0 => {
                a.max = value as i32;
                a.source_time = value;
            }
            1 => {
                a.delta = value as f32;
                a.current = a.max as f32 * a.delta;
            }
            2 if value == 1.0 => a.reset_progress(),
            3..=9 if value == 0.0 || value == 1.0 => {
                let bit = [COMPLETE, STOP, LOOP, WALK, RUN, AIM, WAIT][(field - 3) as usize];
                if value == 1.0 {
                    a.flags |= bit;
                } else {
                    a.flags &= !bit;
                }
            }
            10 if value == 0.0 || value == 1.0 => a.portable = value == 1.0,
            11 if a.origin == 1 && transfer_kind(a.kind) && (value == 0.0 || value == 1.0) => {
                if value == 1.0 {
                    a.flags |= SOURCE_GRAB_STARTED;
                } else {
                    a.flags &= !SOURCE_GRAB_STARTED;
                }
            }
            12 if a.origin == 1 && a.kind == 5 && (value == 0.0 || value == 1.0) => {
                if value == 1.0 {
                    a.flags |= ALLOW_MISSING;
                } else {
                    a.flags &= !ALLOW_MISSING;
                }
            }
            _ => return OUT_OF_RANGE,
        }
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_length() -> u32 {
    STORE.with(|s| s.borrow().fifo.len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_get(index: u32) -> i32 {
    STORE.with(|s| s.borrow().fifo.get(index as usize).copied().unwrap_or(0) as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_current() -> i32 {
    STORE.with(|s| s.borrow().current as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_lookup(id: u32) -> i32 {
    STORE.with(|s| {
        s.borrow()
            .fifo
            .iter()
            .position(|v| *v == id)
            .map_or(0, |i| i as i32 + 1)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_insert(index: u32, id: u32) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if index as usize > s.fifo.len()
            || s.fifo.len() == ACTIONS
            || s.action(id).is_none()
            || s.fifo.contains(&id)
        {
            return OUT_OF_RANGE;
        }
        s.fifo.insert(index as usize, id);
        if s.current == 0
            && s.event.is_none()
            && s.fifo.first().copied() == Some(id)
            && s.action(id).is_some_and(|a| a.origin == 0)
        {
            return s.begin(id);
        }
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_remove(index: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if index as usize >= s.fifo.len() {
            return OUT_OF_RANGE;
        }
        let id = s.fifo.remove(index as usize);
        if s.event.is_none_or(|e| e.action != id) {
            s.retire(id);
            let status = s.begin_head();
            if status != OK {
                return status;
            }
        }
        id as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_clear() -> i32 {
    cancel_queue()
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_new(id: u32, raw: f64) -> i32 {
    STORE.with(|s| {
        s.borrow_mut()
            .new_group(id, raw)
            .map_or_else(|e| e, |id| id as i32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_length(id: u32) -> i32 {
    STORE.with(|s| {
        s.borrow()
            .action(id)
            .map_or(OUT_OF_RANGE, |a| a.groups.len() as i32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_get(id: u32, index: u32) -> i32 {
    STORE.with(|s| {
        s.borrow()
            .action(id)
            .and_then(|a| a.groups.get(index as usize))
            .copied()
            .unwrap_or(0) as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_insert(id: u32, index: u32, gid: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.group(gid).is_none_or(|g| g.action != id) {
            return OUT_OF_RANGE;
        }
        let Some(a) = s.action_mut(id) else {
            return OUT_OF_RANGE;
        };
        if index as usize > a.groups.len() || a.groups.contains(&gid) {
            return OUT_OF_RANGE;
        }
        a.groups.insert(index as usize, gid);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_remove(id: u32, index: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(a) = s.action_mut(id) else {
            return OUT_OF_RANGE;
        };
        if index as usize >= a.groups.len() {
            return OUT_OF_RANGE;
        }
        a.groups.remove(index as usize) as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_read(id: u32) -> i32 {
    STORE.with(|s| {
        let s = s.borrow();
        let Some(g) = s.group(id) else {
            return OUT_OF_RANGE;
        };
        row(&[g.id as f64, g.action as f64, g.raw, g.items.len() as f64]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_item_length(id: u32) -> i32 {
    STORE.with(|s| {
        s.borrow()
            .group(id)
            .map_or(OUT_OF_RANGE, |g| g.items.len() as i32)
    })
}
// Item IDs retain all 32 bits; f64 keeps JS Number results distinct from i32 errors.
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_item_get(id: u32, index: u32) -> f64 {
    STORE.with(|s| {
        s.borrow()
            .group(id)
            .and_then(|g| g.items.get(index as usize))
            .copied()
            .unwrap_or(0) as f64
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_group_item_source_get(id: u32, index: u32) -> f64 {
    STORE.with(|state| {
        let state = state.borrow();
        state
            .group(id)
            .filter(|group| (index as usize) < group.items.len())
            .map_or(OUT_OF_RANGE as f64, |group| {
                group.sources[index as usize] as f64
            })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_item_insert(id: u32, index: u32, item_id: u32) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    let Some(item) = item(item_id) else {
        return OUT_OF_RANGE;
    };
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(action) = s.group(id).and_then(|group| s.action(group.action)) else {
            return OUT_OF_RANGE;
        };
        if (action.kind == 3 && !item.world_object)
            || (action.kind == 5 && item.owner_container != action.source_container)
        {
            return OUT_OF_RANGE;
        }
        let Some(g) = s.group_mut(id) else {
            return OUT_OF_RANGE;
        };
        if index as usize > g.items.len()
            || g.items.len() == GROUP_ITEMS
            || g.definition
                .is_some_and(|definition| definition != item.definition)
        {
            return OUT_OF_RANGE;
        }
        g.definition = Some(item.definition);
        g.sources
            .copy_within(index as usize..g.items.len(), index as usize + 1);
        g.sources[index as usize] = item.owner_container;
        g.items.insert(index as usize, item_id);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_group_item_remove(id: u32, index: u32) -> f64 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(g) = s.group_mut(id) else {
            return OUT_OF_RANGE as f64;
        };
        if index as usize >= g.items.len() {
            return OUT_OF_RANGE as f64;
        }
        let item = g.items.remove(index as usize);
        g.sources
            .copy_within(index as usize + 1..g.items.len() + 1, index as usize);
        g.sources[g.items.len()] = 0;
        item as f64
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_start(id: u32, time: f64, already_adjusted: u32) -> i32 {
    if already_adjusted > 1 || !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.event
            .is_some_and(|e| e.action == id && e.kind == 7 && !e.begin_supplied)
            && s.current == id
            && s.fifo.first().copied() == Some(id)
        {
            let Some(a) = s
                .action_mut(id)
                .filter(|a| a.origin == 1 && already_adjusted == 1)
            else {
                return OUT_OF_RANGE;
            };
            a.max = time as i32;
            a.source_time = time;
            s.event.as_mut().unwrap().begin_supplied = true;
            return OK;
        }
        if !s.start_eligible(id) {
            return OUT_OF_RANGE;
        }
        let a = s.action(id).unwrap();
        if (a.origin == 1) != (already_adjusted == 1) {
            return OUT_OF_RANGE;
        }
        let max = if already_adjusted == 1 {
            time as i32
        } else {
            adjusted(time)
        };
        let result = s.begin_at(id, max);
        if result == OK && already_adjusted == 1 {
            s.action_mut(id).unwrap().source_time = time;
        }
        result
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_event_read() -> i32 {
    STORE.with(|s| {
        if let Some(e) = s.borrow().event {
            row(&[
                e.action as f64,
                e.kind as f64,
                e.generation as f64,
                e.token as f64,
            ]);
            1
        } else {
            row(&[0.0; 4]);
            0
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_event_reply(id: u32, event: u32, token: u32, result: i32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(e) = s.event else {
            return OUT_OF_RANGE;
        };
        if (e.action, e.kind, e.token) != (id, event, token)
            || ((event == 1 || event == 2) && result != 0 && result != 1 && result >= 0)
            || (event > 2 && result > 0)
            || (event == 7 && result >= 0 && !e.begin_supplied)
        {
            return OUT_OF_RANGE;
        }
        s.rollback_transfer();
        s.event = None;
        if result < 0 {
            s.abort();
            return OK;
        }
        match event {
            7 => s.emit(id, 1, false),
            1 if result == 0 => s.emit(id, 6, e.frame),
            1 if e.frame => s.frame_valid(id),
            1 => s.emit(id, 2, false),
            2 if result == 0 => {
                let status = s.start_native(id);
                if status != OK {
                    return status;
                }
                s.emit(id, 3, e.frame)
            }
            2 => OK,
            3 => {
                if e.frame {
                    s.source_completion(id, true)
                } else {
                    OK
                }
            }
            4 => s.source_completion(id, true),
            5 => {
                // Source onCompleted is the only dequeue authority. A remaining
                // entry is a grouped continuation whose original perform reset time.
                let attached = s.fifo.contains(&id);
                let Store {
                    actions, groups, ..
                } = &mut *s;
                let keep = actions.iter().find(|a| a.id == id);
                groups.retain(|g| g.action != id || keep.is_some_and(|a| a.groups.contains(&g.id)));
                let stop = s
                    .action(id)
                    .is_some_and(|a| a.flags & STOP != 0 && a.flags & STARTED != 0);
                if let Some(a) = s.action_mut(id) {
                    a.flags &= !COMPLETE;
                }
                if attached && s.action(id).is_some_and(|a| transfer_kind(a.kind)) {
                    let next = s
                        .action(id)
                        .unwrap()
                        .groups
                        .first()
                        .and_then(|gid| s.group(*gid))
                        .and_then(|g| g.items.first())
                        .copied()
                        .and_then(item);
                    let Some(next) = next else {
                        s.abort();
                        return BLOCKED;
                    };
                    let a = s.action_mut(id).unwrap();
                    a.target = next.id;
                    if a.kind == 3 {
                        a.source_container = next.owner_container;
                        a.xyz = (next.x.floor() as i32, next.y.floor() as i32, 0);
                    }
                }
                if stop {
                    return s.emit(id, 6, e.frame);
                }
                if !attached {
                    s.retire(id);
                }
                if s.deferred != 0 {
                    let next = s.deferred;
                    s.deferred = 0;
                    if let Some(a) = s.action(next) {
                        let max = a.max;
                        return s.begin_at(next, max);
                    }
                    s.abort();
                    OUT_OF_RANGE
                } else {
                    s.begin_head()
                }
            }
            6 => {
                s.retire(id);
                s.canceling = false;
                s.preserve_movement = false;
                if s.deferred != 0 {
                    let next = s.deferred;
                    s.deferred = 0;
                    if let Some(a) = s.action(next) {
                        let max = a.max;
                        return s.begin_at(next, max);
                    }
                    s.abort();
                    OUT_OF_RANGE
                } else {
                    s.begin_head()
                }
            }
            _ => OUT_OF_RANGE,
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_commit_item(id: u32, gid: u32, item_id: u32, token: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.event.is_none_or(|e| {
            e.action != id
                || e.kind != 5
                || e.token != token
                || e.group != gid
                || !e.authorized[..e.authorized_count].contains(&item_id)
                || e.consumed[..e.consumed_count].contains(&item_id)
                || e.consumed_count == GROUP_ITEMS
        }) || s
            .action(id)
            .is_none_or(|a| a.origin != 1 || !transfer_kind(a.kind))
            || s.group(gid).is_none_or(|g| g.action != id)
        {
            return OUT_OF_RANGE;
        }
        let a = s.action(id).unwrap();
        let event = s.event.unwrap();
        let source = event.authorized_sources[event.authorized[..event.authorized_count]
            .iter()
            .position(|id| *id == item_id)
            .unwrap()];
        let result = transfer(item_id, source, a.destination_container);
        if result == OK {
            let event = s.event.as_mut().unwrap();
            event.consumed[event.consumed_count] = item_id;
            event.consumed_count += 1;
        }
        result
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_transfer_read(id: u32) -> i32 {
    STORE.with(|state| {
        let state = state.borrow();
        let Some(action) = state.action(id).filter(|action| transfer_kind(action.kind)) else {
            return OUT_OF_RANGE;
        };
        row(&[
            action.source_container as f64,
            action.destination_container as f64,
            action.xyz.0 as f64,
            action.xyz.1 as f64,
            action.xyz.2 as f64,
        ]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_action_bind_transfer(id: u32, source: u32, destination: u32) -> i32 {
    if !mutation_allowed() || source == destination {
        return OUT_OF_RANGE;
    }
    STORE.with(|state| {
        let mut state = state.borrow_mut();
        if state.fifo.contains(&id) || state.event.is_some_and(|event| event.action == id) {
            return OUT_OF_RANGE;
        }
        let Some(action) = state.action_mut(id).filter(|action| {
            action.kind == 5 && action.source_container == 0 && action.destination_container == 0
        }) else {
            return OUT_OF_RANGE;
        };
        let supported = ITEMS.with(|items| {
            let items = items.borrow();
            items
                .live
                .iter()
                .find(|item| item.id == action.target)
                .is_some_and(|item| item.owner_container == source)
                && items.container(source).is_some()
                && items.container(destination).is_some()
        });
        if !supported {
            return OUT_OF_RANGE;
        }
        action.source_container = source;
        action.destination_container = destination;
        let root = ITEMS.with(|items| {
            let items = items.borrow();
            let root = items.outermost(destination).unwrap();
            items
                .container(root)
                .filter(|row| row.kind == 2)
                .map(|row| row.xyz)
        });
        action.xyz = root.unwrap_or_else(actor_square);
        OK
    })
}

fn transfer_time(item: u32, source: u32, destination: u32) -> f64 {
    let (weight, base, delta, floor_factor, hands_slot, favorite_leaving) = ITEMS.with(|items| {
        let items = items.borrow();
        let item = items.live.iter().find(|row| row.id == item).unwrap();
        let source_actor = items.outermost(source) == Some(PLAYER_INVENTORY);
        let destination_actor = items.outermost(destination) == Some(PLAYER_INVENTORY);
        let row = items.container(destination).unwrap();
        let mut base = 120.0;
        let mut delta = 1.0;
        if source == PLAYER_INVENTORY {
            if destination_actor {
                let max = if destination == PLAYER_INVENTORY {
                    MOODLES.with(|state| state.borrow().inputs[MOODLE_MAX_WEIGHT] as i32)
                } else {
                    Items::source_capacity(row)
                };
                delta = items.container_capacity_weight(destination) as f64 / max as f64;
            } else {
                base = 50.0;
            }
        } else if !source_actor && destination_actor {
            base = 50.0;
        }
        let floor_factor = if row.type_token == 2 {
            if source == PLAYER_INVENTORY {
                0.1
            } else if source_actor {
                1.0
            } else {
                0.2
            }
        } else {
            1.0
        };
        (
            item.actual_weight,
            base,
            delta,
            floor_factor,
            items.hands_slot,
            item.source_flags & 1 != 0 && !destination_actor,
        )
    });
    timing::transfer_base(
        weight,
        base,
        delta,
        floor_factor,
        item_wearing_awkward_gloves(hands_slot) != 0,
        favorite_leaving,
    )
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_request_transfer(item: u32, source: u32, destination: u32) -> i32 {
    let status = transfer_check(item, source, destination, -1);
    if status != OK {
        return status;
    }
    let raw = transfer_time(item, source, destination);
    STORE.with(|state| {
        let mut state = state.borrow_mut();
        if state.actions.len() == ACTIONS
            || state.fifo.len() == ACTIONS
            || state.groups.len() == GROUPS
            || state.next_action > i32::MAX as u32
            || state.next_group > i32::MAX as u32
        {
            return OUT_OF_RANGE;
        }
        let definition = ITEMS.with(|items| {
            items
                .borrow()
                .live
                .iter()
                .find(|row| row.id == item)
                .unwrap()
                .definition
        });
        let xyz = ITEMS.with(|items| {
            let items = items.borrow();
            [destination, source]
                .iter()
                .find_map(|id| {
                    items
                        .outermost(*id)
                        .and_then(|root| items.container(root))
                        .filter(|row| row.kind == 2)
                        .map(|row| row.xyz)
                })
                .unwrap_or_else(actor_square)
        });
        let id = state.new_action(5, 0, item, xyz, raw).unwrap();
        let action = state.action_mut(id).unwrap();
        action.source_container = source;
        action.destination_container = destination;
        let group = state.new_group(id, raw).unwrap();
        let row = state.group_mut(group).unwrap();
        row.definition = Some(definition);
        row.items.push(item);
        row.sources[0] = source;
        state.action_mut(id).unwrap().groups.push(group);
        state.fifo.push(id);
        let status = state.begin_head();
        if status != OK {
            return status;
        }
        id as i32
    })
}

fn authorized_item(state: &Store, action: u32, group: u32, item: u32, token: u32) -> bool {
    state.event.is_some_and(|event| {
        event.action == action
            && event.kind == 5
            && event.token == token
            && event.group == group
            && event.authorized[..event.authorized_count].contains(&item)
            && !event.consumed[..event.consumed_count].contains(&item)
            && event.consumed_count < GROUP_ITEMS
    }) && state
        .action(action)
        .is_some_and(|row| row.origin == 1 && transfer_kind(row.kind))
        && state.group(group).is_some_and(|row| row.action == action)
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_transfer_begin(
    action: u32,
    group: u32,
    item: u32,
    token: u32,
    policy: i32,
) -> i32 {
    STORE.with(|state| {
        let mut state = state.borrow_mut();
        if state.transfer.is_some() || !authorized_item(&state, action, group, item, token) {
            return OUT_OF_RANGE;
        }
        let row = state.action(action).unwrap();
        let destination = row.destination_container;
        let event = state.event.unwrap();
        let source = event.authorized_sources[event.authorized[..event.authorized_count]
            .iter()
            .position(|id| *id == item)
            .unwrap()];
        let admission =
            ITEMS.with(|items| items.borrow().container(destination).unwrap().kind != 2);
        let status = transfer_check_inner(item, source, destination, policy, admission);
        if status != OK {
            return status;
        }
        let transaction = ITEMS.with(|items| {
            let mut items = items.borrow_mut();
            let index = items.live.iter().position(|row| row.id == item).unwrap();
            items.source_transfer = true;
            TransferTransaction {
                action,
                token,
                item: items.live[index],
                index,
                held: items.held,
                worn_index: items.worn.iter().position(|id| *id == item),
                attached_index: items.attached.iter().position(|id| *id == item),
                rng_state: doors::rng_state(),
                container_flags: [
                    items.container(source).unwrap().flags,
                    items.container(destination).unwrap().flags,
                ],
                actor_overlay: items.actor_overlay,
                source,
                destination,
                detached: false,
                added: false,
            }
        });
        // Reserve once even when a helper fails: a replied event cannot replay.
        let event = state.event.as_mut().unwrap();
        event.consumed[event.consumed_count] = item;
        event.consumed_count += 1;
        state.transfer = Some(transaction);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_transfer_random(
    action: u32,
    item: u32,
    token: u32,
    min: f64,
    max: f64,
    integer: u32,
) -> f64 {
    if !min.is_finite() || !max.is_finite() {
        return NONFINITE as f64;
    }
    if integer > 1
        || min < 0.0
        || max > F32_MAX
        || min >= max
        || (integer == 1 && (min.fract() != 0.0 || max.fract() != 0.0 || max > i32::MAX as f64))
    {
        return OUT_OF_RANGE as f64;
    }
    STORE.with(|state| {
        let state = state.borrow();
        if state
            .event
            .is_none_or(|event| event.action != action || event.kind != 5 || event.token != token)
            || state.transfer.as_ref().is_none_or(|transaction| {
                transaction.action != action
                    || transaction.token != token
                    || transaction.item.id != item
            })
        {
            return OUT_OF_RANGE as f64;
        }
        if integer == 1 {
            min + doors::random((max - min) as u64) as f64
        } else {
            let unit = doors::random(1 << 24) as f32 / (1 << 24) as f32;
            (min as f32 + unit * (max as f32 - min as f32)) as f64
        }
    })
}

pub(super) fn source_flags_needed(id: u32) -> bool {
    STORE.with(|state| {
        let state = state.borrow();
        state.actions.iter().any(|action| action.target == id)
            || state.groups.iter().any(|group| group.items.contains(&id))
            || state
                .event
                .is_some_and(|event| event.authorized[..event.authorized_count].contains(&id))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_transfer_operation(
    action: u32,
    item: u32,
    token: u32,
    operation: u32,
    container: u32,
    x: f64,
    y: f64,
    z: i32,
) -> i32 {
    STORE.with(|state| {
        let mut state = state.borrow_mut();
        if state
            .event
            .is_none_or(|event| event.action != action || event.kind != 5 || event.token != token)
        {
            return OUT_OF_RANGE;
        }
        let Some(transaction) = state.transfer.as_mut().filter(|transaction| {
            transaction.action == action
                && transaction.token == token
                && transaction.item.id == item
        }) else {
            return OUT_OF_RANGE;
        };
        ITEMS.with(|items| {
            let mut items = items.borrow_mut();
            let Some(index) = items.live.iter().position(|row| row.id == item) else {
                return OUT_OF_RANGE;
            };
            match operation {
                1 => {
                    if transaction.detached
                        || transaction.added
                        || container != transaction.source
                        || items.live[index].owner_container != transaction.source
                    {
                        return OUT_OF_RANGE;
                    }
                    items.live[index].owner_container = 0;
                    transaction.detached = true;
                }
                2 => {
                    if !transaction.detached
                        || transaction.added
                        || container != transaction.destination
                        || items.live[index].world_object
                    {
                        return OUT_OF_RANGE;
                    }
                    let mut row = items.live.remove(index);
                    row.owner_container = container;
                    items.live.push(row);
                    transaction.added = true;
                }
                3 => {
                    if !transaction.detached
                        || transaction.added
                        || !items.live[index].world_object
                        || !transaction.item.world_object
                        || container != transaction.source
                    {
                        return OUT_OF_RANGE;
                    }
                    items.live[index].world_object = false;
                }
                4 => {
                    if !transaction.detached
                        || !transaction.added
                        || container != transaction.destination
                        || items.live[index].owner_container != container
                        || items.live[index].world_object
                        || items.container(container).unwrap().kind != 2
                    {
                        return OUT_OF_RANGE;
                    }
                    if z != 0 {
                        return UNSUPPORTED;
                    }
                    if !x.is_finite() || !y.is_finite() {
                        return NONFINITE;
                    }
                    if !item_position_valid(x, y)
                        || items.container(container).unwrap().xyz
                            != (x.floor() as i32, y.floor() as i32, z)
                    {
                        return OUT_OF_RANGE;
                    }
                    items.live[index].world_object = true;
                    items.live[index].x = x;
                    items.live[index].y = y;
                }
                5 => {
                    if !transaction.detached || container != transaction.source {
                        return OUT_OF_RANGE;
                    }
                    items.clear_held(item);
                }
                6 => {
                    if container != PLAYER_INVENTORY {
                        return OUT_OF_RANGE;
                    }
                    items.actor_overlay = 0;
                }
                7 => {
                    if !transaction.detached || container != transaction.source {
                        return OUT_OF_RANGE;
                    }
                    items.remove_worn(item);
                }
                8 => {
                    if !transaction.detached || container != transaction.source {
                        return OUT_OF_RANGE;
                    }
                    items.attached.retain(|id| *id != item);
                }
                _ => return OUT_OF_RANGE,
            }
            OK
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_transfer_finish(action: u32, item: u32, token: u32, success: u32) -> i32 {
    STORE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(transaction) = state.transfer.as_ref().filter(|transaction| {
            transaction.action == action
                && transaction.token == token
                && transaction.item.id == item
        }) else {
            return OUT_OF_RANGE;
        };
        if success > 1
            || state.event.is_none_or(|event| {
                event.action != action || event.kind != 5 || event.token != token
            })
        {
            return OUT_OF_RANGE;
        }
        if success == 0 {
            state.rollback_transfer();
            return OK;
        }
        let valid = transaction.detached
            && transaction.added
            && ITEMS.with(|items| {
                let items = items.borrow();
                let row = items.live.iter().find(|row| row.id == item).unwrap();
                row.owner_container == transaction.destination
                    && row.world_object
                        == (items.container(transaction.destination).unwrap().kind == 2)
                    && (row.owner_container == PLAYER_INVENTORY
                        || (row.slot == 0 && !items.held.contains(&item)))
            });
        if !valid {
            state.rollback_transfer();
            return BAD_FORMAT;
        }
        state.transfer = None;
        ITEMS.with(|items| items.borrow_mut().source_transfer = false);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_commit_door(id: u32, door_id: u32, token: u32) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.event
            .is_none_or(|e| e.action != id || e.kind != 5 || e.token != token || e.committed_door)
            || s.action(id)
                .is_none_or(|a| a.origin != 1 || a.kind != 2 || a.target != door_id)
        {
            return OUT_OF_RANGE;
        }
        let result = doors::commit_toggle(door_id);
        if result == OK {
            s.event.as_mut().unwrap().committed_door = true;
        }
        result
    })
}

fn adjacent(target: (i32, i32, i32), door: Option<u32>) -> Result<Option<(i32, i32, i32)>, i32> {
    let actor = actor_square();
    if door.is_none()
        && (target.0 as f64 + 0.5 - position_x() as f64).abs() <= 1.6
        && (target.1 as f64 + 0.5 - position_y() as f64).abs() <= 1.6
        && doors::can_reach(actor, target)?
    {
        return Ok(Some(actor));
    }
    // The synthetic plane has no source square metadata; its actual passable
    // coordinates remain usable without inventing room/stand cache entries.
    if !world_extents().0 && door.is_none() && doors::room(target).is_none() {
        return Ok(Some(target));
    }
    let mut choices = [(0, 0, 0); 4];
    let mut count = 0;
    fn add(
        choices: &mut [(i32, i32, i32); 4],
        count: &mut usize,
        target: (i32, i32, i32),
        key: (i32, i32, i32),
        window: bool,
    ) {
        if *count < 4 && doors::adjacent_allowed(target, key, window) {
            choices[*count] = key;
            *count += 1;
        }
    }
    if let Some(id) = door {
        let north = doors::north(id).ok_or(OUT_OF_RANGE)?;
        let near = if north {
            (
                target.0,
                target.1.checked_sub(1).ok_or(OUT_OF_RANGE)?,
                target.2,
            )
        } else {
            (
                target.0.checked_sub(1).ok_or(OUT_OF_RANGE)?,
                target.1,
                target.2,
            )
        };
        let room = doors::room(actor).ok_or(OUT_OF_RANGE)?;
        if doors::room(near) == Some(room) {
            add(&mut choices, &mut count, target, near, true);
        }
        if doors::room(target) == Some(room) {
            add(&mut choices, &mut count, target, target, true);
        }
        if count == 0 {
            if doors::adjacent_allowed(target, near, true) {
                choices[count] = near;
                count += 1;
            }
            if doors::stand_room(target).is_some() {
                choices[count] = target;
                count += 1;
            }
        }
    } else {
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            if let (Some(x), Some(y)) = (target.0.checked_add(dx), target.1.checked_add(dy)) {
                add(&mut choices, &mut count, target, (x, y, target.2), false);
            }
        }
    }
    if count == 0 {
        for (dx, dy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
            if let (Some(x), Some(y)) = (target.0.checked_add(dx), target.1.checked_add(dy)) {
                let key = (x, y, target.2);
                if doors::adjacent_allowed(target, key, door.is_some()) {
                    choices[count] = key;
                    count += 1;
                }
            }
        }
    }
    let mut distance = 100000.0_f64;
    let mut selected = None;
    for key in choices[..count].iter().copied() {
        let dx = key.0 as f32 + 0.5 - position_x();
        let dy = key.1 as f32 + 0.5 - position_y();
        let d = (dx * dx + dy * dy).sqrt() as f64;
        if d < distance && (door.is_some() || doors::can_reach(key, target)?) {
            distance = d;
            selected = Some(key);
        }
    }
    Ok(selected)
}
fn pickup_stand(mut target: (i32, i32, i32)) -> Result<Option<(i32, i32, i32)>, i32> {
    if world_extents().0 {
        let west = doors::source_square_has(target.0, target.1, target.2, 1);
        let north = doors::source_square_has(target.0, target.1, target.2, 0);
        if west < 0 || north < 0 {
            return Err(OUT_OF_RANGE);
        }
        // Source luautils.getCorrectSquareForWall, including W-before-N order.
        if west == 1 && position_x() < target.0 as f32 {
            target.0 = target.0.checked_add(1).ok_or(OUT_OF_RANGE)?;
        } else if north == 1 && position_y() < target.1 as f32 {
            target.1 = target.1.checked_add(1).ok_or(OUT_OF_RANGE)?;
        }
    }
    adjacent(target, None)
}
fn append_walk(s: &mut Store, target: (i32, i32, i32)) -> Result<(), i32> {
    if target == s.tail_square() {
        return Ok(());
    }
    let id = s.new_action(1, 0, 0, target, -1.0)?;
    s.fifo.push(id);
    if s.current == 0 && s.event.is_none() && s.fifo.first().copied() == Some(id) {
        let status = s.begin(id);
        if status != OK {
            return Err(status);
        }
    }
    Ok(())
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_request_pickup(item_id: u32) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    let Some(i) = item(item_id).filter(|i| i.world_object) else {
        return OUT_OF_RANGE;
    };
    let target = (i.x.floor() as i32, i.y.floor() as i32, 0);
    let stand = match pickup_stand(target) {
        Ok(Some(stand)) => stand,
        Ok(None) => return BLOCKED,
        Err(error) => return error,
    };
    let (carried, hands_slot) = ITEMS.with(|items| {
        let items = items.borrow();
        (items.capacity_weight(), items.hands_slot)
    });
    let awkward = item_wearing_awkward_gloves(hands_slot) != 0;
    let max_weight = MOODLES.with(|m| m.borrow().inputs[MOODLE_MAX_WEIGHT] as i32);
    let raw = timing::pickup_base(i.actual_weight, carried, max_weight, awkward);
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let tail = s.tail_square();
        let can_merge = match doors::can_reach(tail, target) {
            Ok(value) => value,
            Err(error) => return error,
        };
        if let Some(last) = s
            .fifo
            .last()
            .copied()
            .filter(|id| s.action(*id).is_some_and(|a| a.kind == 3) && can_merge)
        {
            let existing = s.action(last).unwrap().groups.iter().copied().find(|gid| {
                let g = s.group(*gid).unwrap();
                g.items.len() < GROUP_ITEMS && g.definition == Some(i.definition)
            });
            if let Some(gid) = existing {
                let group = s.group_mut(gid).unwrap();
                group.sources[group.items.len()] = i.owner_container;
                group.items.push(item_id);
                return last as i32;
            }
            let gid = match s.new_group(last, raw) {
                Ok(id) => id,
                Err(e) => return e,
            };
            let group = s.group_mut(gid).unwrap();
            group.definition = Some(i.definition);
            group.sources[0] = i.owner_container;
            group.items.push(item_id);
            s.action_mut(last).unwrap().groups.push(gid);
            return last as i32;
        }
        let needed = 1 + usize::from(stand != s.tail_square());
        if s.actions.len() + needed > ACTIONS
            || s.fifo.len() + needed > ACTIONS
            || s.groups.len() == GROUPS
            || s.next_action as u64 + needed as u64 - 1 > i32::MAX as u64
            || s.next_group > i32::MAX as u32
        {
            return OUT_OF_RANGE;
        }
        if let Err(e) = append_walk(&mut s, stand) {
            return e;
        }
        let id = s.new_action(3, 0, item_id, target, raw).unwrap();
        let gid = s.new_group(id, raw).unwrap();
        let group = s.group_mut(gid).unwrap();
        group.definition = Some(i.definition);
        group.sources[0] = i.owner_container;
        group.items.push(item_id);
        s.action_mut(id).unwrap().groups.push(gid);
        s.fifo.push(id);
        if s.current == 0 && s.event.is_none() && s.fifo.first().copied() == Some(id) {
            let status = s.begin(id);
            if status != OK {
                return status;
            }
        }
        id as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_request_door(door_id: u32) -> i32 {
    if !mutation_allowed() {
        return OUT_OF_RANGE;
    }
    let Some(target) = doors::position(door_id) else {
        return OUT_OF_RANGE;
    };
    let stand = match adjacent(target, Some(door_id)) {
        Ok(Some(stand)) => stand,
        Ok(None) => return BLOCKED,
        Err(error) => return error,
    };
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let needed = 1 + usize::from(stand != s.tail_square());
        if s.actions.len() + needed > ACTIONS
            || s.fifo.len() + needed > ACTIONS
            || s.next_action as u64 + needed as u64 - 1 > i32::MAX as u64
        {
            return OUT_OF_RANGE;
        }
        if let Err(e) = append_walk(&mut s, stand) {
            return e;
        }
        let id = s.new_action(2, 0, door_id, target, 0.0).unwrap();
        s.fifo.push(id);
        if s.current == 0 && s.event.is_none() && s.fifo.first().copied() == Some(id) {
            let status = s.begin(id);
            if status != OK {
                return status;
            }
        }
        id as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_request_walk(x: i32, y: i32, z: i32) -> i32 {
    if z != 0 || !item_position_valid(x as f64 + 0.5, y as f64 + 0.5) {
        return OUT_OF_RANGE;
    }
    if world_extents().0 && !tile_passable(tile_at(x as i64, y as i64)) {
        return BLOCKED;
    }
    let id = queue_action_new(1, 0, 0, x, y, z, -1.0);
    if id <= 0 {
        return id;
    }
    let status = queue_insert(queue_length(), id as u32);
    if status != OK {
        STORE.with(|s| s.borrow_mut().retire(id as u32));
        return status;
    }
    id
}
#[unsafe(no_mangle)]
pub extern "C" fn source_path_cancel() -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(event) = s.event else {
            return OUT_OF_RANGE;
        };
        if (event.kind != 5 && event.kind != 6)
            || s.action(event.action).is_none_or(|a| a.kind != 1)
        {
            return OUT_OF_RANGE;
        }
        if s.path_owner == event.action {
            clear_world_path();
            mutate(|e| e.cancel());
            s.path_owner = 0;
        }
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_path_result(id: u32) -> i32 {
    STORE.with(|s| {
        let s = s.borrow();
        let Some(a) = s.action(id).filter(|a| a.kind == 1) else {
            return OUT_OF_RANGE;
        };
        if s.path_owner != id {
            return 2;
        }
        ENGINE.with(|e| {
            let e = e.borrow();
            let target = (a.xyz.0 as f32 + 0.5, a.xyz.1 as f32 + 0.5);
            if e.action == ACTION_DESTINATION && (e.target_x, e.target_y) == target {
                0
            } else if e.action == ACTION_IDLE && e.is_at(target.0, target.1) {
                1
            } else {
                2
            }
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_face(x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    mutate(|e| {
        let (hx, hy) = unit_direction(x - e.x as f64, y - e.y as f64);
        e.heading_x = hx;
        e.heading_y = hy;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_is_sitting() -> u32 {
    POSTURE.with(|s| u32::from(*s.borrow()))
}
#[unsafe(no_mangle)]
pub extern "C" fn source_retrigger_get() -> i32 {
    STORE.with(|s| s.borrow().retrigger as i32)
}
#[unsafe(no_mangle)]
pub extern "C" fn source_retrigger_set(id: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if id != 0 && s.action(id).is_none() {
            return OUT_OF_RANGE;
        }
        s.retrigger = id;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_action_discard(id: u32) -> i32 {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.current == id
            || s.retrigger == id
            || s.fifo.contains(&id)
            || s.event.is_some_and(|e| e.action == id)
            || s.action(id).is_none_or(|a| a.flags & STARTED != 0)
        {
            return OUT_OF_RANGE;
        }
        s.retire(id);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_adjacent_read(kind: u32, target: u32, x: i32, y: i32, z: i32) -> i32 {
    if z != 0 || !(1..=2).contains(&kind) {
        return OUT_OF_RANGE;
    }
    let xyz = if kind == 2 {
        let Some(xyz) = doors::position(target) else {
            return OUT_OF_RANGE;
        };
        xyz
    } else {
        (x, y, z)
    };
    if doors::room(xyz).is_none() {
        return OUT_OF_RANGE;
    }
    match adjacent(xyz, if kind == 2 { Some(target) } else { None }) {
        Ok(Some((x, y, z))) => {
            row(&[x as f64, y as f64, z as f64]);
            1
        }
        Ok(None) => 0,
        Err(error) => error,
    }
}

fn word(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn wide(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn portable_target_valid(a: &Action) -> bool {
    if a.xyz.2 != 0 {
        return false;
    }
    match a.kind {
        1 => {
            a.target == 0
                && item_position_valid(a.xyz.0 as f64 + 0.5, a.xyz.1 as f64 + 0.5)
                && (!world_extents().0 || tile_passable(tile_at(a.xyz.0 as i64, a.xyz.1 as i64)))
        }
        2 => doors::position(a.target) == Some(a.xyz),
        3 => {
            a.destination_container == PLAYER_INVENTORY
                && item(a.target)
                    .is_some_and(|i| i.world_object && i.owner_container == a.source_container)
                && ITEMS.with(|state| {
                    state
                        .borrow()
                        .container(a.source_container)
                        .is_some_and(|row| row.kind == 2)
                })
        }
        5 => {
            item(a.target).is_some_and(|i| i.owner_container == a.source_container)
                && ITEMS.with(|state| {
                    let state = state.borrow();
                    state.container(a.source_container).is_some()
                        && state.container(a.destination_container).is_some()
                })
        }
        4 => a.origin == 1 && (a.target == u32::MAX || doors::position(a.target).is_some()),
        _ => false,
    }
}
fn encode(s: &Store) -> Result<Vec<u8>, i32> {
    if !items_available()
        || s.event.is_some()
        || s.canceling
        || s.deferred != 0
        || s.actions.iter().any(|a| {
            !a.portable
                || !s.fifo.contains(&a.id)
                || !portable_target_valid(a)
                || (transfer_kind(a.kind) && a.groups.is_empty())
        })
        || s.groups.iter().any(|g| {
            g.items.is_empty()
                || s.action(g.action).is_none_or(|a| !a.groups.contains(&g.id))
                || g.definition.is_none_or(|definition| {
                    g.items.iter().enumerate().any(|(index, id)| {
                        item(*id).is_none_or(|i| {
                            i.owner_container != g.sources[index]
                                || i.definition != definition
                                || s.action(g.action).is_some_and(|a| {
                                    a.kind == 3
                                        && (!i.world_object
                                            || ITEMS.with(|state| {
                                                state
                                                    .borrow()
                                                    .container(g.sources[index])
                                                    .is_none_or(|row| row.kind != 2)
                                            }))
                                })
                        }) || s
                            .action(g.action)
                            .is_some_and(|a| a.kind == 5 && g.sources[index] != a.source_container)
                    })
                })
        })
    {
        return Err(OUT_OF_RANGE);
    }
    let mut bytes = Vec::with_capacity(64 + s.actions.len() * 80 + s.groups.len() * 100);
    word(&mut bytes, 0x31515a50);
    word(&mut bytes, 2);
    word(&mut bytes, s.next_action);
    word(&mut bytes, s.next_group);
    word(&mut bytes, s.current);
    word(&mut bytes, s.generation);
    word(&mut bytes, s.next_token);
    word(&mut bytes, s.retrigger);
    word(&mut bytes, source_is_sitting());
    word(&mut bytes, s.path_owner);
    let timing = timing::snapshot_words();
    word(&mut bytes, timing.len() as u32);
    for value in timing {
        word(&mut bytes, value);
    }
    word(&mut bytes, s.actions.len() as u32);
    word(&mut bytes, s.fifo.len() as u32);
    word(&mut bytes, s.groups.len() as u32);
    for a in &s.actions {
        for value in [
            a.id,
            a.kind,
            a.origin,
            a.target,
            a.xyz.0 as u32,
            a.xyz.1 as u32,
            a.xyz.2 as u32,
        ] {
            word(&mut bytes, value);
        }
        word(&mut bytes, a.source_container);
        word(&mut bytes, a.destination_container);
        wide(&mut bytes, a.raw.to_bits());
        wide(&mut bytes, a.source_time.to_bits());
        word(&mut bytes, a.max as u32);
        for value in [a.current, a.last, a.prev, a.delta] {
            word(&mut bytes, value.to_bits());
        }
        word(&mut bytes, a.flags);
        word(&mut bytes, u32::from(a.portable));
        word(&mut bytes, a.groups.len() as u32);
        for gid in &a.groups {
            word(&mut bytes, *gid);
        }
    }
    for id in &s.fifo {
        word(&mut bytes, *id);
    }
    for g in &s.groups {
        word(&mut bytes, g.id);
        word(&mut bytes, g.action);
        wide(&mut bytes, g.raw.to_bits());
        word(&mut bytes, g.definition.ok_or(OUT_OF_RANGE)?);
        word(&mut bytes, g.items.len() as u32);
        for (index, id) in g.items.iter().enumerate() {
            word(&mut bytes, *id);
            word(&mut bytes, g.sources[index]);
        }
    }
    if bytes.len() > PAYLOAD {
        return Err(OUT_OF_RANGE);
    }
    Ok(bytes)
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn word(&mut self) -> Result<u32, i32> {
        let end = self.at.checked_add(4).ok_or(BAD_FORMAT)?;
        let bytes = self.bytes.get(self.at..end).ok_or(BAD_FORMAT)?;
        self.at = end;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }
    fn wide(&mut self) -> Result<u64, i32> {
        let lo = self.word()? as u64;
        let hi = self.word()? as u64;
        Ok(lo | hi << 32)
    }
    fn count(&mut self, limit: usize) -> Result<usize, i32> {
        let count = self.word()? as usize;
        if count > limit {
            Err(BAD_FORMAT)
        } else {
            Ok(count)
        }
    }
}
fn decode(bytes: &[u8]) -> Result<(Store, timing::TimingContext), i32> {
    if bytes.len() > PAYLOAD {
        return Err(BAD_FORMAT);
    }
    let mut r = Reader { bytes, at: 0 };
    if r.word()? != 0x31515a50 {
        return Err(BAD_FORMAT);
    }
    let version = r.word()?;
    if version != 1 && version != 2 {
        return Err(BAD_FORMAT);
    }
    let mut s = Store::new();
    s.next_action = r.word()?;
    s.next_group = r.word()?;
    s.current = r.word()?;
    s.generation = r.word()?;
    s.next_token = r.word()?;
    s.retrigger = r.word()?;
    if r.word()? != 0 {
        return Err(BAD_FORMAT);
    }
    s.path_owner = r.word()?;
    let time_count = r.count(140)?;
    let mut words = Vec::with_capacity(time_count);
    for _ in 0..time_count {
        words.push(r.word()?);
    }
    if version == 1 && words.get(9).is_none_or(|word| *word > 1) {
        return Err(BAD_FORMAT);
    }
    let timing = timing::validate_words(&words)?;
    let action_count = r.count(ACTIONS)?;
    let fifo_count = r.count(ACTIONS)?;
    let group_count = r.count(GROUPS)?;
    if fifo_count != action_count {
        return Err(BAD_FORMAT);
    }
    let mut action_ids = HashSet::with_capacity(action_count);
    let mut group_refs = HashSet::with_capacity(group_count);
    for _ in 0..action_count {
        let id = r.word()?;
        let kind = r.word()?;
        let origin = r.word()?;
        let target = r.word()?;
        let xyz = (r.word()? as i32, r.word()? as i32, r.word()? as i32);
        let references = if version == 2 {
            Some((r.word()?, r.word()?))
        } else {
            None
        };
        let raw = f64::from_bits(r.wide()?);
        let mut a = Action::new(id, kind, origin, target, xyz, raw);
        if let Some((source, destination)) = references {
            a.source_container = source;
            a.destination_container = destination;
        }
        a.source_time = f64::from_bits(r.wide()?);
        a.max = r.word()? as i32;
        a.current = f32::from_bits(r.word()?);
        a.last = f32::from_bits(r.word()?);
        a.prev = f32::from_bits(r.word()?);
        a.delta = f32::from_bits(r.word()?);
        a.flags = r.word()?;
        let portable = r.word()?;
        a.portable = portable == 1;
        let count = r.count(GROUPS)?;
        for _ in 0..count {
            let gid = r.word()?;
            if gid == 0 || !group_refs.insert(gid) {
                return Err(BAD_FORMAT);
            }
            a.groups.push(gid);
        }
        let target_valid = portable_target_valid(&a);
        if id == 0
            || id >= s.next_action
            || !action_ids.insert(id)
            || origin > 1
            || (version == 1 && kind > 4)
            || (!transfer_kind(kind) && (a.source_container != 0 || a.destination_container != 0))
            || (transfer_kind(kind) && a.source_container == a.destination_container)
            || portable != 1
            || a.flags & !(511 | ALLOW_MISSING) != 0
            || (a.flags & ALLOW_MISSING != 0 && (origin != 1 || kind != 5 || version == 1))
            || !target_valid
            || xyz.2 != 0
            || (a.flags & SOURCE_GRAB_STARTED != 0 && (origin != 1 || !transfer_kind(kind)))
            || (origin == 1 && a.source_time as i32 != a.max)
            || (!transfer_kind(kind) && count != 0)
            || (transfer_kind(kind) && count == 0)
            || (id != s.current && a.flags & STARTED != 0)
        {
            return Err(BAD_FORMAT);
        }
        s.actions.push(a);
    }
    let mut fifo_ids = HashSet::with_capacity(fifo_count);
    for _ in 0..fifo_count {
        let id = r.word()?;
        if !action_ids.contains(&id) || !fifo_ids.insert(id) {
            return Err(BAD_FORMAT);
        }
        s.fifo.push(id);
    }
    let mut group_ids = HashSet::with_capacity(group_count);
    for _ in 0..group_count {
        let id = r.word()?;
        let action = r.word()?;
        let raw = f64::from_bits(r.wide()?);
        let accepted_definition = r.word()?;
        let count = r.count(GROUP_ITEMS)?;
        if count == 0
            || id == 0
            || id >= s.next_group
            || !group_ids.insert(id)
            || !group_refs.contains(&id)
            || s.action(action)
                .is_none_or(|a| !transfer_kind(a.kind) || !a.groups.contains(&id))
        {
            return Err(BAD_FORMAT);
        }
        let mut items = Vec::with_capacity(GROUP_ITEMS);
        let mut sources = [0; GROUP_ITEMS];
        for slot in sources.iter_mut().take(count) {
            let item_id = r.word()?;
            let i = item(item_id).ok_or(BAD_FORMAT)?;
            let source = if version == 2 {
                r.word()?
            } else {
                i.owner_container
            };
            if i.owner_container != source
                || i.definition != accepted_definition
                || s.action(action).is_some_and(|a| match a.kind {
                    3 => {
                        !i.world_object
                            || ITEMS.with(|state| {
                                state
                                    .borrow()
                                    .container(source)
                                    .is_none_or(|row| row.kind != 2)
                            })
                    }
                    5 => source != a.source_container,
                    _ => false,
                })
            {
                return Err(BAD_FORMAT);
            }
            items.push(item_id);
            *slot = source;
        }
        s.groups.push(Group {
            id,
            action,
            raw,
            definition: Some(accepted_definition),
            items,
            sources,
        });
    }
    if r.at != bytes.len()
        || group_ids.len() != group_refs.len()
        || s.next_action == 0
        || s.next_action > i32::MAX as u32 + 1
        || s.next_group == 0
        || s.next_group > i32::MAX as u32 + 1
        || s.next_token == 0
        || (s.current != 0 && s.fifo.first().copied() != Some(s.current))
    {
        return Err(BAD_FORMAT);
    }
    if (s.retrigger != 0 && !action_ids.contains(&s.retrigger))
        || (health() == 0.0 && action_count != 0)
    {
        return Err(BAD_FORMAT);
    }
    if s.path_owner != 0 {
        let a = s.action(s.path_owner).ok_or(BAD_FORMAT)?;
        if s.path_owner != s.current || a.kind != 1 || a.flags & STARTED == 0 {
            return Err(BAD_FORMAT);
        }
        let e = ENGINE.with(|e| *e.borrow());
        let destination = (a.xyz.0 as f32 + 0.5, a.xyz.1 as f32 + 0.5);
        if (e.action == ACTION_DESTINATION && (e.target_x, e.target_y) != destination)
            || e.action == ACTION_WALKING
        {
            return Err(BAD_FORMAT);
        }
        // Idle may mean reached or failed; preserve the actual actor state.
        // Revoked owner0 never authorizes or restarts the replacement route.
    }
    Ok((s, timing))
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_save_size() -> i32 {
    let result = STORE.with(|s| encode(&s.borrow()));
    match result {
        Ok(bytes) => {
            let count = bytes.len() as i32;
            SAVED.with(|s| *s.borrow_mut() = bytes);
            count
        }
        Err(e) => {
            SAVED.with(|s| s.borrow_mut().clear());
            e
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_save_read(offset: u32) -> i32 {
    SAVED.with(|s| {
        let s = s.borrow();
        let offset = offset as usize;
        if offset >= s.len() {
            return OUT_OF_RANGE;
        }
        let count = (s.len() - offset).min(4096);
        QUEUE_SCRATCH.with(|scratch| {
            let mut scratch = scratch.borrow_mut();
            for (index, byte) in s[offset..offset + count].iter().enumerate() {
                let shift = (index % 8) * 8;
                let slot = &mut scratch[index / 8];
                *slot = (*slot & !(255u64 << shift)) | ((*byte as u64) << shift);
            }
        });
        count as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_restore_begin(count: u32) -> i32 {
    RESTORE.with(|s| {
        *s.borrow_mut() = None;
        if count == 0 || count as usize > PAYLOAD {
            return OUT_OF_RANGE;
        }
        *s.borrow_mut() = Some((vec![0; count as usize], 0));
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_restore_write(offset: u32, count: u32) -> i32 {
    RESTORE.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((bytes, next)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        if offset as usize != *next
            || count == 0
            || count > 4096
            || *next + count as usize > bytes.len()
        {
            *stage = None;
            return BAD_FORMAT;
        }
        QUEUE_SCRATCH.with(|scratch| {
            let scratch = scratch.borrow();
            for index in 0..count as usize {
                bytes[*next + index] = (scratch[index / 8] >> ((index % 8) * 8)) as u8;
            }
        });
        *next += count as usize;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_restore_abort() -> i32 {
    RESTORE.with(|s| *s.borrow_mut() = None);
    OK
}
#[unsafe(no_mangle)]
pub extern "C" fn queue_restore_commit() -> i32 {
    let stage = RESTORE.with(|s| s.borrow_mut().take());
    let Some((bytes, next)) = stage else {
        return BAD_FORMAT;
    };
    if next != bytes.len() || !items_available() {
        return BAD_FORMAT;
    }
    let (mut store, context) = match decode(&bytes) {
        Ok(value) => value,
        Err(e) => return e,
    };
    // Tokens cannot roll back into a previously authorized callback generation.
    STORE.with(|live| {
        let live = live.borrow();
        store.next_token = store.next_token.max(live.next_token);
        store.generation = store.generation.max(live.generation);
        store.next_action = store.next_action.max(live.next_action);
        store.next_group = store.next_group.max(live.next_group);
    });
    timing::restore_validated(context);
    STORE.with(|live| *live.borrow_mut() = store);
    SAVED.with(|s| s.borrow_mut().clear());
    OK
}

pub(super) fn full_reset() {
    invalidate();
    POSTURE.with(|s| *s.borrow_mut() = false);
}

#[cfg(test)]
pub(super) fn event_row_for_test() -> (u32, u32) {
    STORE.with(|s| {
        let e = s.borrow().event.unwrap();
        (e.kind, e.token)
    })
}
#[cfg(test)]
pub(super) fn adjacent_row_for_test() -> (i32, i32, i32) {
    QUEUE_SCRATCH.with(|s| {
        let s = s.borrow();
        (
            f64::from_bits(s[0]) as i32,
            f64::from_bits(s[1]) as i32,
            f64::from_bits(s[2]) as i32,
        )
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_item_has_room(id: u32) -> i32 {
    ITEMS.with(|items| {
        let items = items.borrow();
        items
            .live
            .iter()
            .find(|item| item.id == id)
            .map_or(OUT_OF_RANGE, |item| {
                items
                    .has_room_item(PLAYER_INVENTORY, 1, item, -1)
                    .map_or_else(|code| code, i32::from)
            })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn queue_source_time_read(id: u32) -> i32 {
    STORE.with(|s| {
        let s = s.borrow();
        let Some(a) = s.action(id).filter(|a| a.origin == 1) else {
            return OUT_OF_RANGE;
        };
        row(&[a.source_time]);
        OK
    })
}

#[cfg(test)]
pub(super) fn queue_words_for_test() -> [f64; 4] {
    QUEUE_SCRATCH.with(|s| {
        let s = s.borrow();
        std::array::from_fn(|index| f64::from_bits(s[index]))
    })
}
