import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface ArtifactMeta {
  'id' : bigint,
  'title' : [] | [string],
  'kind' : string,
  'mime' : [] | [string],
  'created_at' : bigint,
  'total_size' : [] | [bigint],
  'chunk_count' : [] | [number],
  'notes' : [] | [string],
}
export interface Contact {
  'id' : bigint,
  'shared' : boolean,
  'relationship' : [] | [string],
  'owner' : Principal,
  'name' : string,
  'created_at' : bigint,
  'email' : string,
  'keywords' : [] | [Array<string>],
  'company' : [] | [string],
}
export interface CourierMessage {
  'id' : bigint,
  'content' : string,
  'recipient' : Principal,
  'created_at' : bigint,
  'sender' : Principal,
}
export interface DocumentSection {
  'id' : bigint,
  'title' : string,
  'content' : string,
  'section' : string,
  'manual_name' : string,
  'category' : [] | [string],
  'embedding' : [] | [Array<number>],
}
export interface EmergencyAudioChunk {
  'id' : bigint,
  'data' : Uint8Array | number[],
  'emergency_id' : bigint,
  'created_at' : bigint,
}
export interface EmergencyEvent {
  'id' : bigint,
  'secure_token' : string,
  'owner' : Principal,
  'started_at' : bigint,
}
export interface EvolutionDeltas {
  'vendor_skepticism_delta' : number,
  'snark_level_delta' : number,
  'proactive_interruption_delta' : number,
  'technical_precision_delta' : number,
}
export interface EvolutionLogEntry {
  'id' : bigint,
  'owner' : Principal,
  'summary' : string,
  'timestamp' : bigint,
}
export interface EvolutionProfile {
  'proactive_interruption' : number,
  'technical_precision' : number,
  'snark_level' : number,
  'vendor_skepticism' : number,
}
export interface GeneratedArtifact {
  'id' : bigint,
  'title' : [] | [string],
  'owner' : Principal,
  'data' : Uint8Array | number[],
  'kind' : string,
  'mime' : [] | [string],
  'created_at' : bigint,
  'total_size' : [] | [bigint],
  'chunk_count' : [] | [number],
  'notes' : [] | [string],
}
export interface Message {
  'content' : string,
  'role' : string,
  'compressed' : [] | [boolean],
  'timestamp' : bigint,
}
export interface NewChunk {
  'title' : string,
  'content' : string,
  'section' : string,
  'embedding' : Array<number>,
}
export interface PersonaProfile {
  'name' : [] | [string],
  'voice_id' : [] | [string],
}
export interface RosterProfile {
  'id' : bigint,
  'owner' : Principal,
  'name' : string,
  'role' : [] | [string],
  'created_at' : bigint,
  'trigger_phrase' : string,
  'notes' : [] | [string],
}
export interface ScoredSection { 'section' : DocumentSection, 'score' : number }
export interface SessionInfo {
  'principal' : Principal,
  'name' : [] | [string],
  'voice_id' : [] | [string],
}
export interface Workspace {
  'id' : bigint,
  'status' : WorkspaceStatus,
  'owner' : Principal,
  'name' : string,
  'created_at' : bigint,
  'associated_manuals' : [] | [Array<string>],
  'scratchpad' : [] | [string],
}
export type WorkspaceStatus = { 'Active' : null } |
  { 'Archived' : null };
export interface _SERVICE {
  'add_contact' : ActorMethod<
    [
      string,
      string,
      [] | [string],
      [] | [string],
      [] | [Array<string>],
      boolean,
    ],
    bigint
  >,
  'add_manual_chunks' : ActorMethod<
    [string, [] | [string], Array<NewChunk>],
    BigUint64Array | bigint[]
  >,
  'add_manual_section' : ActorMethod<[string, string, string, string], bigint>,
  'add_roster_profile' : ActorMethod<
    [string, string, [] | [string], [] | [string]],
    bigint
  >,
  'append_artifact_chunk' : ActorMethod<
    [bigint, Uint8Array | number[]],
    undefined
  >,
  'append_emergency_audio_chunk' : ActorMethod<
    [bigint, Uint8Array | number[]],
    bigint
  >,
  'append_turn' : ActorMethod<[bigint, string, string], bigint>,
  'archive_workspace' : ActorMethod<[bigint], undefined>,
  'create_workspace' : ActorMethod<[string], bigint>,
  'delete_artifact' : ActorMethod<[bigint], undefined>,
  'delete_contact' : ActorMethod<[bigint], undefined>,
  'delete_manual' : ActorMethod<[string], bigint>,
  'delete_manual_section' : ActorMethod<[bigint], boolean>,
  'delete_roster_profile' : ActorMethod<[bigint], undefined>,
  'delete_workspace' : ActorMethod<[bigint], undefined>,
  'get_artifact' : ActorMethod<[bigint], [] | [GeneratedArtifact]>,
  'get_artifact_chunk' : ActorMethod<
    [bigint, number],
    [] | [Uint8Array | number[]]
  >,
  'get_cycle_balance' : ActorMethod<[], bigint>,
  'get_history' : ActorMethod<[bigint], Array<Message>>,
  'get_manual_section' : ActorMethod<[bigint], [] | [DocumentSection]>,
  'get_my_evolution_profile' : ActorMethod<[], EvolutionProfile>,
  'get_my_persona_profile' : ActorMethod<[], [] | [PersonaProfile]>,
  'get_pump_config' : ActorMethod<[], [Principal, bigint, bigint, bigint]>,
  'greet' : ActorMethod<[string], string>,
  'list_emergency_audio_chunks' : ActorMethod<
    [bigint],
    Array<EmergencyAudioChunk>
  >,
  'list_manual_names' : ActorMethod<[], Array<string>>,
  'list_my_artifacts' : ActorMethod<[], Array<ArtifactMeta>>,
  'list_my_contacts' : ActorMethod<[], Array<Contact>>,
  'list_my_emergencies' : ActorMethod<[], Array<EmergencyEvent>>,
  'list_my_evolution_log' : ActorMethod<[number], Array<EvolutionLogEntry>>,
  'list_my_roster_profiles' : ActorMethod<[], Array<RosterProfile>>,
  'list_my_workspaces' : ActorMethod<[], Array<Workspace>>,
  'list_sections_by_manual' : ActorMethod<[string], Array<DocumentSection>>,
  'login' : ActorMethod<[], { 'Ok' : string } | { 'Err' : string }>,
  'manual_category_map' : ActorMethod<[], Array<[string, string]>>,
  'overwrite_turn_content' : ActorMethod<[bigint, bigint, string], undefined>,
  'pop_pending_courier_messages' : ActorMethod<[], Array<CourierMessage>>,
  'purge_history' : ActorMethod<[bigint], undefined>,
  'queue_courier_message' : ActorMethod<[string], bigint>,
  'record_evolution_event' : ActorMethod<[EvolutionDeltas, string], bigint>,
  'restore_workspace' : ActorMethod<[bigint], undefined>,
  'search_manuals_by_keyword' : ActorMethod<
    [Array<string>],
    Array<DocumentSection>
  >,
  'search_similar_chunks' : ActorMethod<
    [Array<number>, number],
    Array<ScoredSection>
  >,
  'set_persona_profile' : ActorMethod<[string, string], undefined>,
  'start_artifact' : ActorMethod<
    [string, [] | [string], [] | [string], [] | [string]],
    bigint
  >,
  'start_emergency' : ActorMethod<[string], bigint>,
  'trigger_fuel_pump' : ActorMethod<[], string>,
  'update_associated_manuals' : ActorMethod<[bigint, Array<string>], undefined>,
  'update_contact' : ActorMethod<
    [
      bigint,
      string,
      string,
      [] | [string],
      [] | [string],
      [] | [Array<string>],
      boolean,
    ],
    undefined
  >,
  'update_roster_profile' : ActorMethod<
    [bigint, string, string, [] | [string], [] | [string]],
    undefined
  >,
  'update_scratchpad' : ActorMethod<[bigint, string], undefined>,
  'validate_session' : ActorMethod<[string], [] | [SessionInfo]>,
  'verify_unlock' : ActorMethod<[], boolean>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
