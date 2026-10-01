import {
  planExternalObjectDeletion,
  planItemDeletion,
  planParentDeletion,
  planRepositoryDeletion,
  planResetLocalData,
  runIsActive,
} from "../domain/deletion";
import type { Runtime } from "./runtime";
import type { MachineAccess } from "./machine-access";
import { GitCli } from "./git";
import { resolveMachinePath } from "./machine-path";

export const RESET_CONFIRMATION_PHRASE = "RESET ALL LOCAL DATA";

export function createDeletionCommandHandlers(runtime: Runtime, access: MachineAccess) {
  const pending = new Map<string, string>();
  const stateKey = (includeAuditEntryCount = false) =>
    JSON.stringify(
      includeAuditEntryCount
        ? { domainState: runtime.snapshot(), auditEntryCount: runtime.auditEntryCount() }
        : runtime.snapshot(),
    );
  const save = (key: string) => pending.set(key, stateKey(key === "reset"));
  const current = (key: string, label: string, staleMessage?: string) => {
    const expected = pending.get(key);
    if (!expected) throw new Error(`Review the ${label} deletion preview before deleting it`);
    if (expected !== stateKey(key === "reset"))
      throw new Error(
        staleMessage ??
          `The ${label} changed after the preview; review the updated deletion preview`,
      );
  };
  const summaryParent = (plan: ReturnType<typeof planParentDeletion>) => ({
    contextId: plan.contextId,
    projectId: plan.projectId,
    projectCount: plan.projects.length,
    itemCount: plan.items.length,
    repositoryCount: plan.repositories.length,
    machineCount: plan.machines.length,
    workspaceCount: plan.workspaces.length,
    runCount: plan.runs.length,
    reminderCount: plan.reminderCount,
    relationshipCount: plan.relationshipCount,
    linkCount: plan.linkIds.length,
    attentionDefaultCount: plan.attentionDefaults.length,
    externalObjectCount: plan.orphanedExternalObjectIds.length,
    snapshotCount: plan.orphanedSnapshotCount,
    activityCount: plan.orphanedActivityCount,
  });
  const itemPreview = (itemId: number) => {
    const plan = planItemDeletion(runtime.snapshot(), itemId);
    return {
      plan,
      blockers: plan.activeRunIds.map(
        (id) => `Run #${id} is active; stop it before deleting this Item.`,
      ),
    };
  };
  const parentPreview = (contextId: number | null, projectId: number | null) => {
    const plan = planParentDeletion(runtime.snapshot(), contextId, projectId);
    const blockers = plan.activeRunIds.map(
      (id) =>
        `Run #${id} is active; stop it before deleting this ${contextId === null ? "Project" : "Context"}.`,
    );
    if (contextId !== null && runtime.snapshot().contexts.length === 1)
      blockers.push("This is the last Context; create another Context before deleting it.");
    return { plan, blockers };
  };
  const extPreview = (externalObjectId: number) => {
    const state = runtime.snapshot();
    const plan = planExternalObjectDeletion(state, externalObjectId);
    const links = plan.linkIds.map((linkId) => {
      const link = state.links.find((entry) => entry.id === linkId)!;
      const item = state.items.find((entry) => entry.id === link.item_id);
      if (!item) throw new Error(`Item ${link.item_id} disappeared while building preview`);
      return {
        linkId,
        itemId: item.id,
        itemIdentifier: item.human_identifier,
        itemTitle: item.title,
      };
    });
    return {
      plan,
      links,
      providerWarning:
        "This only removes local Mission Manager data. GitHub Issues, pull requests, and other provider-owned objects are never deleted.",
    };
  };
  const repositoryPreview = (repositoryId: number) => {
    const state = runtime.snapshot();
    const plan = planRepositoryDeletion(state, repositoryId);
    const blockers = state.runs.flatMap((run) => {
      const uses =
        run.repository_id === repositoryId ||
        run.direct_checkouts.some((checkout) => checkout.repositoryId === repositoryId) ||
        (run.worktree_id !== null &&
          state.worktrees.some(
            (tree) => tree.id === run.worktree_id && tree.repositoryId === repositoryId,
          ));
      return uses
        ? [`Run #${run.id} on Item #${run.item_id} uses this Repository and must be deleted first.`]
        : [];
    });
    return { plan, blockers };
  };
  const physicalWorktreeSnapshot = async (worktreeId: number) => {
    const state = runtime.snapshot();
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId);
    if (!worktree) throw new Error(`Worktree ${worktreeId} does not exist`);
    const repository = state.repositories.find((entry) => entry.id === worktree.repositoryId);
    if (!repository) throw new Error(`Repository ${worktree.repositoryId} does not exist`);
    const machine = state.machines.find((entry) => entry.id === worktree.machineId);
    if (!machine) throw new Error(`Machine ${worktree.machineId} does not exist`);
    const location = state.repository_locations.find(
      (entry) =>
        entry.repository_id === worktree.repositoryId && entry.machine_id === worktree.machineId,
    );
    if (!location)
      throw new Error(
        `Repository ${repository.name} has no checkout registered on Machine ${machine.name}`,
      );
    const home = await access.machineHome(machine);
    const checkoutPath = resolveMachinePath(location.checkout_path, home);
    const worktreePath = resolveMachinePath(worktree.path, home);
    const inspection = await new GitCli(access).validateAttachment(
      machine,
      repository,
      checkoutPath,
      worktreePath,
      worktree.branch,
      true,
    );
    const report = {
      worktreeId,
      workspaceId: worktree.workspaceId,
      repositoryId: worktree.repositoryId,
      repositoryName: repository.name,
      machineId: worktree.machineId,
      path: worktree.path,
      branch: worktree.branch,
      isDirty: inspection.isDirty,
      requiresDestructiveConfirmation: inspection.isDirty,
    };
    return { report, worktree, repository, machine, location, checkoutPath, worktreePath };
  };
  const worktreeSnapshots = new Map<number, Awaited<ReturnType<typeof physicalWorktreeSnapshot>>>();
  const worktreeIdentityIsCurrent = (
    snapshot: Awaited<ReturnType<typeof physicalWorktreeSnapshot>>,
  ) => {
    const state = runtime.snapshot();
    return (
      JSON.stringify(state.worktrees.find((entry) => entry.id === snapshot.worktree.id)) ===
        JSON.stringify(snapshot.worktree) &&
      JSON.stringify(state.repositories.find((entry) => entry.id === snapshot.repository.id)) ===
        JSON.stringify(snapshot.repository) &&
      JSON.stringify(
        state.repository_locations.find(
          (entry) =>
            entry.repository_id === snapshot.location.repository_id &&
            entry.machine_id === snapshot.location.machine_id,
        ),
      ) === JSON.stringify(snapshot.location) &&
      (() => {
        const machine = state.machines.find((entry) => entry.id === snapshot.machine.id);
        return (
          machine !== undefined &&
          machine.id === snapshot.machine.id &&
          machine.context_id === snapshot.machine.context_id &&
          machine.name === snapshot.machine.name &&
          machine.socket_name === snapshot.machine.socket_name &&
          JSON.stringify(machine.transport) === JSON.stringify(snapshot.machine.transport)
        );
      })()
    );
  };
  return {
    prepare_item_deletion: (args: Record<string, unknown>) => {
      const itemId = Number(args.itemId);
      const preview = itemPreview(itemId);
      save(`item:${itemId}`);
      return preview;
    },
    delete_item: (args: Record<string, unknown>) => {
      const itemId = Number(args.itemId);
      if (!args.confirmed)
        throw new Error(
          "Item deletion requires explicit confirmation after reviewing its deletion preview",
        );
      current(`item:${itemId}`, "Item");
      const preview = itemPreview(itemId);
      if (preview.blockers.length)
        throw new Error(`Item deletion is blocked:\n${preview.blockers.join("\n")}`);
      const plan = preview.plan;
      const summary = {
        itemId,
        reminderCount: plan.reminderCount,
        relationshipCount: plan.relationshipCount,
        workspaceCount: plan.workspaces.length,
        runCount: plan.runIds.length,
        linkCount: plan.linkIds.length,
        externalObjectCount: plan.orphanedExternalObjectIds.length,
        snapshotCount: plan.orphanedSnapshotCount,
        activityCount: plan.orphanedActivityCount,
      };
      runtime.dispatch({ type: "delete_item", itemId });
      pending.delete(`item:${itemId}`);
      return { summary };
    },
    prepare_project_deletion: (args: Record<string, unknown>) => {
      const id = Number(args.projectId);
      const preview = parentPreview(null, id);
      save(`project:${id}`);
      return preview;
    },
    delete_project: (args: Record<string, unknown>) => {
      const id = Number(args.projectId);
      if (!args.confirmed)
        throw new Error(
          "Project deletion requires explicit confirmation after reviewing its deletion preview",
        );
      current(`project:${id}`, "Project");
      const preview = parentPreview(null, id);
      if (preview.blockers.length)
        throw new Error(`Project deletion is blocked:\n${preview.blockers.join("\n")}`);
      const plan = preview.plan;
      runtime.dispatch({
        type: "delete_project",
        projectId: id,
        itemIds: (args.itemIds as number[]) ?? [],
        repositoryIds: (args.repositoryIds as number[]) ?? [],
        workspaceIds: (args.workspaceIds as number[]) ?? [],
      });
      pending.delete(`project:${id}`);
      return { summary: summaryParent(plan) };
    },
    prepare_context_deletion: (args: Record<string, unknown>) => {
      const id = Number(args.contextId);
      const preview = parentPreview(id, null);
      save(`context:${id}`);
      return preview;
    },
    delete_context: (args: Record<string, unknown>) => {
      const id = Number(args.contextId);
      if (!args.confirmed)
        throw new Error(
          "Context deletion requires explicit confirmation after reviewing its deletion preview",
        );
      current(`context:${id}`, "Context");
      const preview = parentPreview(id, null);
      if (preview.blockers.length)
        throw new Error(`Context deletion is blocked:\n${preview.blockers.join("\n")}`);
      const plan = preview.plan;
      runtime.dispatch({
        type: "delete_context",
        contextId: id,
        projectIds: (args.projectIds as number[]) ?? [],
        itemIds: (args.itemIds as number[]) ?? [],
        repositoryIds: (args.repositoryIds as number[]) ?? [],
        workspaceIds: (args.workspaceIds as number[]) ?? [],
        machineIds: (args.machineIds as number[]) ?? [],
      });
      pending.delete(`context:${id}`);
      return { summary: summaryParent(plan) };
    },
    prepare_repository_deletion: (args: Record<string, unknown>) => {
      const id = Number(args.repositoryId);
      const preview = repositoryPreview(id);
      save(`repository:${id}`);
      return preview;
    },
    delete_repository: (args: Record<string, unknown>) => {
      const id = Number(args.repositoryId);
      if (!args.confirmed)
        throw new Error(
          "Repository deletion requires explicit confirmation after reviewing its deletion preview",
        );
      current(
        `repository:${id}`,
        "Repository",
        "The Repository or its Item execution references changed after the preview; review the updated deletion preview before deleting it",
      );
      const preview = repositoryPreview(id);
      if (preview.blockers.length)
        throw new Error(`Repository deletion is blocked:\n${preview.blockers.join("\n")}`);
      runtime.dispatch({
        type: "delete_repository",
        repositoryId: id,
        workspaceIds: (args.workspaceIds as number[]) ?? [],
      });
      pending.delete(`repository:${id}`);
      return { repositoryId: id, workspaceCount: preview.plan.workspaces.length };
    },
    prepare_external_object_deletion: (args: Record<string, unknown>) => {
      const id = Number(args.externalObjectId);
      const preview = extPreview(id);
      save(`external:${id}`);
      return preview;
    },
    delete_external_object: (args: Record<string, unknown>) => {
      const id = Number(args.externalObjectId);
      if (!args.confirmed)
        throw new Error(
          "External Object deletion requires explicit confirmation after reviewing its local deletion preview",
        );
      current(
        `external:${id}`,
        "External Object",
        "The External Object or one of its Links changed after the preview; review the updated local deletion preview before deleting it",
      );
      const plan = extPreview(id).plan;
      runtime.dispatch({ type: "delete_external_object", externalObjectId: id });
      pending.delete(`external:${id}`);
      return {
        summary: {
          externalObjectId: id,
          linkCount: plan.linkIds.length,
          snapshotCount: plan.snapshotCount,
          activityCount: plan.activityCount,
        },
      };
    },
    unlink_external_link: (args: Record<string, unknown>) => {
      const linkId = Number(args.linkId);
      if (!args.confirmed) throw new Error("Unlinking an Item requires explicit confirmation");
      const link = runtime.snapshot().links.find((entry) => entry.id === linkId);
      if (!link) throw new Error(`Link ${linkId} does not exist`);
      const externalObjectDeleted = !runtime
        .snapshot()
        .links.some(
          (entry) => entry.id !== linkId && entry.external_object_id === link.external_object_id,
        );
      runtime.dispatch({ type: "delete_link", linkId });
      return { linkId, externalObjectId: link.external_object_id, externalObjectDeleted };
    },
    prepare_reset_local_data: () => {
      const state = runtime.snapshot();
      const plan = planResetLocalData(state);
      const blockers = state.runs
        .filter(runIsActive)
        .map((run) => `Run #${run.id} is active; stop it before resetting local data.`);
      const preview = {
        plan,
        auditEntryCount: runtime.auditEntryCount(),
        blockers,
        confirmationPhrase: RESET_CONFIRMATION_PHRASE,
      };
      save("reset");
      return preview;
    },
    reset_all_local_data: (args: Record<string, unknown>) => {
      const confirmation = String(args.confirmation ?? "");
      if (confirmation !== RESET_CONFIRMATION_PHRASE)
        throw new Error(
          `Reset requires the exact confirmation phrase: ${RESET_CONFIRMATION_PHRASE}`,
        );
      if (!pending.has("reset"))
        throw new Error("Review the reset preview before resetting local data");
      if (pending.get("reset") !== stateKey(true))
        throw new Error(
          "The local model changed after the reset preview; review the updated preview before resetting local data",
        );
      const state = runtime.snapshot();
      const plan = planResetLocalData(state);
      const blockers = state.runs.filter(runIsActive);
      if (blockers.length)
        throw new Error(
          `Reset is blocked:\n${blockers.map((run) => `Run #${run.id} is active; stop it before resetting local data.`).join("\n")}`,
        );
      const auditEntryCount = runtime.auditEntryCount();
      runtime.dispatch({ type: "reset_local_data" });
      pending.clear();
      return { summary: plan.summary, auditEntryCount };
    },
    prepare_worktree_removal: async (args: Record<string, unknown>) => {
      const id = Number(args.worktreeId);
      const snapshot = await physicalWorktreeSnapshot(id);
      if (!worktreeIdentityIsCurrent(snapshot))
        throw new Error(
          "The Worktree or its Repository location changed while its state was inspected; review it again",
        );
      worktreeSnapshots.set(id, snapshot);
      return snapshot.report;
    },
    remove_worktree: async (args: Record<string, unknown>) => {
      const id = Number(args.worktreeId);
      if (!args.confirmed)
        throw new Error(
          "Worktree removal requires explicit confirmation after reviewing its safety report",
        );
      const pendingSnapshot = worktreeSnapshots.get(id);
      if (!pendingSnapshot)
        throw new Error("Review the Worktree removal safety report before removing it");
      const observation = await physicalWorktreeSnapshot(id);
      if (JSON.stringify(observation.report) !== JSON.stringify(pendingSnapshot.report))
        throw new Error(
          "The Worktree changed after the safety report; review the updated report before removing it",
        );
      if (observation.report.requiresDestructiveConfirmation && !args.destructiveConfirmed)
        throw new Error("Removing a dirty Worktree requires destructive confirmation");
      await new GitCli(access).removeWorktree(
        observation.machine,
        observation.checkoutPath,
        observation.worktreePath,
        Boolean(args.destructiveConfirmed),
      );
      if (!worktreeIdentityIsCurrent(observation))
        throw new Error(
          "The Worktree was removed from disk, but its application identity changed before the removal could be recorded; reconcile the Worktree state",
        );
      runtime.dispatch({ type: "remove_worktree", worktreeId: id });
      worktreeSnapshots.delete(id);
      return { worktreeId: id, branchPreserved: true };
    },
  };
}
