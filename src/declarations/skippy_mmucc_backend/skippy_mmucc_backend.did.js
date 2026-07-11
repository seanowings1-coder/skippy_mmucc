export const idlFactory = ({ IDL }) => {
  const NewChunk = IDL.Record({
    'title' : IDL.Text,
    'content' : IDL.Text,
    'section' : IDL.Text,
    'embedding' : IDL.Vec(IDL.Float32),
  });
  const Message = IDL.Record({
    'content' : IDL.Text,
    'role' : IDL.Text,
    'timestamp' : IDL.Nat64,
  });
  const DocumentSection = IDL.Record({
    'id' : IDL.Nat64,
    'title' : IDL.Text,
    'content' : IDL.Text,
    'section' : IDL.Text,
    'manual_name' : IDL.Text,
    'category' : IDL.Opt(IDL.Text),
    'embedding' : IDL.Opt(IDL.Vec(IDL.Float32)),
  });
  const EvolutionProfile = IDL.Record({
    'proactive_interruption' : IDL.Float32,
    'technical_precision' : IDL.Float32,
    'snark_level' : IDL.Float32,
    'vendor_skepticism' : IDL.Float32,
  });
  const PersonaProfile = IDL.Record({
    'name' : IDL.Opt(IDL.Text),
    'voice_id' : IDL.Opt(IDL.Text),
  });
  const EmergencyAudioChunk = IDL.Record({
    'id' : IDL.Nat64,
    'data' : IDL.Vec(IDL.Nat8),
    'emergency_id' : IDL.Nat64,
    'created_at' : IDL.Nat64,
  });
  const EmergencyEvent = IDL.Record({
    'id' : IDL.Nat64,
    'secure_token' : IDL.Text,
    'owner' : IDL.Principal,
    'started_at' : IDL.Nat64,
  });
  const EvolutionLogEntry = IDL.Record({
    'id' : IDL.Nat64,
    'owner' : IDL.Principal,
    'summary' : IDL.Text,
    'timestamp' : IDL.Nat64,
  });
  const WorkspaceStatus = IDL.Variant({
    'Active' : IDL.Null,
    'Archived' : IDL.Null,
  });
  const Workspace = IDL.Record({
    'id' : IDL.Nat64,
    'status' : WorkspaceStatus,
    'owner' : IDL.Principal,
    'name' : IDL.Text,
    'created_at' : IDL.Nat64,
    'associated_manuals' : IDL.Opt(IDL.Vec(IDL.Text)),
    'scratchpad' : IDL.Opt(IDL.Text),
  });
  const CourierMessage = IDL.Record({
    'id' : IDL.Nat64,
    'content' : IDL.Text,
    'recipient' : IDL.Principal,
    'created_at' : IDL.Nat64,
    'sender' : IDL.Principal,
  });
  const EvolutionDeltas = IDL.Record({
    'vendor_skepticism_delta' : IDL.Float32,
    'snark_level_delta' : IDL.Float32,
    'proactive_interruption_delta' : IDL.Float32,
    'technical_precision_delta' : IDL.Float32,
  });
  const ScoredSection = IDL.Record({
    'section' : DocumentSection,
    'score' : IDL.Float32,
  });
  const SessionInfo = IDL.Record({
    'principal' : IDL.Principal,
    'name' : IDL.Opt(IDL.Text),
    'voice_id' : IDL.Opt(IDL.Text),
  });
  return IDL.Service({
    'add_manual_chunks' : IDL.Func(
        [IDL.Text, IDL.Opt(IDL.Text), IDL.Vec(NewChunk)],
        [IDL.Vec(IDL.Nat64)],
        [],
      ),
    'add_manual_section' : IDL.Func(
        [IDL.Text, IDL.Text, IDL.Text, IDL.Text],
        [IDL.Nat64],
        [],
      ),
    'append_emergency_audio_chunk' : IDL.Func(
        [IDL.Nat64, IDL.Vec(IDL.Nat8)],
        [IDL.Nat64],
        [],
      ),
    'append_turn' : IDL.Func([IDL.Nat64, IDL.Text, IDL.Text], [IDL.Nat64], []),
    'archive_workspace' : IDL.Func([IDL.Nat64], [], []),
    'create_workspace' : IDL.Func([IDL.Text], [IDL.Nat64], []),
    'delete_manual' : IDL.Func([IDL.Text], [IDL.Nat64], []),
    'delete_manual_section' : IDL.Func([IDL.Nat64], [IDL.Bool], []),
    'delete_workspace' : IDL.Func([IDL.Nat64], [], []),
    'get_cycle_balance' : IDL.Func([], [IDL.Nat64], ['query']),
    'get_history' : IDL.Func([IDL.Nat64], [IDL.Vec(Message)], ['query']),
    'get_manual_section' : IDL.Func(
        [IDL.Nat64],
        [IDL.Opt(DocumentSection)],
        ['query'],
      ),
    'get_my_evolution_profile' : IDL.Func([], [EvolutionProfile], ['query']),
    'get_my_persona_profile' : IDL.Func(
        [],
        [IDL.Opt(PersonaProfile)],
        ['query'],
      ),
    'get_pump_config' : IDL.Func(
        [],
        [IDL.Principal, IDL.Nat, IDL.Nat, IDL.Nat],
        ['query'],
      ),
    'greet' : IDL.Func([IDL.Text], [IDL.Text], ['query']),
    'list_emergency_audio_chunks' : IDL.Func(
        [IDL.Nat64],
        [IDL.Vec(EmergencyAudioChunk)],
        ['query'],
      ),
    'list_manual_names' : IDL.Func([], [IDL.Vec(IDL.Text)], ['query']),
    'list_my_emergencies' : IDL.Func([], [IDL.Vec(EmergencyEvent)], ['query']),
    'list_my_evolution_log' : IDL.Func(
        [IDL.Nat32],
        [IDL.Vec(EvolutionLogEntry)],
        ['query'],
      ),
    'list_my_workspaces' : IDL.Func([], [IDL.Vec(Workspace)], ['query']),
    'list_sections_by_manual' : IDL.Func(
        [IDL.Text],
        [IDL.Vec(DocumentSection)],
        ['query'],
      ),
    'login' : IDL.Func(
        [],
        [IDL.Variant({ 'Ok' : IDL.Text, 'Err' : IDL.Text })],
        [],
      ),
    'manual_category_map' : IDL.Func(
        [],
        [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text))],
        ['query'],
      ),
    'overwrite_turn_content' : IDL.Func(
        [IDL.Nat64, IDL.Nat64, IDL.Text],
        [],
        [],
      ),
    'pop_pending_courier_messages' : IDL.Func(
        [],
        [IDL.Vec(CourierMessage)],
        [],
      ),
    'purge_history' : IDL.Func([IDL.Nat64], [], []),
    'queue_courier_message' : IDL.Func([IDL.Text], [IDL.Nat64], []),
    'record_evolution_event' : IDL.Func(
        [EvolutionDeltas, IDL.Text],
        [IDL.Nat64],
        [],
      ),
    'restore_workspace' : IDL.Func([IDL.Nat64], [], []),
    'search_manuals_by_keyword' : IDL.Func(
        [IDL.Vec(IDL.Text)],
        [IDL.Vec(DocumentSection)],
        ['query'],
      ),
    'search_similar_chunks' : IDL.Func(
        [IDL.Vec(IDL.Float32), IDL.Nat32],
        [IDL.Vec(ScoredSection)],
        ['query'],
      ),
    'set_persona_profile' : IDL.Func([IDL.Text, IDL.Text], [], []),
    'start_emergency' : IDL.Func([IDL.Text], [IDL.Nat64], []),
    'trigger_fuel_pump' : IDL.Func([], [IDL.Text], []),
    'update_associated_manuals' : IDL.Func(
        [IDL.Nat64, IDL.Vec(IDL.Text)],
        [],
        [],
      ),
    'update_scratchpad' : IDL.Func([IDL.Nat64, IDL.Text], [], []),
    'validate_session' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(SessionInfo)],
        ['query'],
      ),
    'verify_unlock' : IDL.Func([], [IDL.Bool], ['query']),
  });
};
export const init = ({ IDL }) => {
  return [IDL.Principal, IDL.Principal, IDL.Principal];
};
