// Reviewed positive input list: test/probe/preview sources are never compiled into Peras.app.
export const productionSwift = [
 'native/Animation/Actor.swift',
 'native/App/PerasNativeApp.swift', 'native/App/SettingsSceneApp.swift',
 'native/Models/CompactMenuModels.swift', 'native/Models/DisplayStyle.swift',
 'native/Models/PresentationModels.swift', 'native/Models/RecapShareModel.swift',
 'native/Models/ShareModel.swift', 'native/Models/Snapshot.swift',
 'native/Models/WeeklyRecap.swift', 'native/Models/WindowResetTracker.swift',
 'native/Platform/AuxiliaryWindows.swift', 'native/Platform/DesktopCoordinator.swift',
 'native/Platform/InstanceLock.swift', 'native/Platform/ShareController.swift', 'native/Platform/StatusItemAppearance.swift',
 'native/Resources/SpriteResources.swift',
 'native/Services/BridgeClient.swift', 'native/Services/BridgeSession.swift',
 'native/Services/LineFramer.swift', 'native/Services/ProductionLaunch.swift',
 'native/Services/RecapShareRenderer.swift', 'native/Services/ShareRenderer.swift',
 'native/Stores/FixtureStore.swift',
 'native/Views/CompactProviderRow.swift', 'native/Views/ContentView.swift',
 'native/Views/NativeSettingsView.swift', 'native/Views/PauseCard.swift',
 'native/Views/PlanningStrip.swift', 'native/Views/PopoverController.swift',
 'native/Views/PresentationPolish.swift', 'native/Views/RecapCaption.swift',
 'native/Views/RecapShareCard.swift', 'native/Views/SettingsDisclosure.swift',
 'native/Views/SetupView.swift', 'native/Views/ShareCard.swift',
 'native/Views/SpriteRail.swift', 'native/Views/UsageWindowView.swift',
];
export function productionResources(atlas) {
 const files = new Set(['atlas.json', 'claude-logo.png', 'codex-logo.png']);
 for (const provider of Object.values(atlas.providers)) {
  files.add(provider.cup); files.add(provider.idle.file);
  for (const frame of [...provider.right, ...(provider.left ?? [])]) files.add(frame.file);
 }
 if([...files].some(f=>!/^[a-z0-9-]+\.(?:png|json)$/.test(f))) throw Error('Invalid production atlas resource name');
 return [...files].sort();
}
export const excludedSymbols = ['NativeChecks','BridgeChecks','DesktopChecks','LaunchChecks','MenuChecks','PresentationChecks','RecapChecks','RecoveryChecks','DesktopProbe','KeyboardProbe','MenuProbe','RailRepaintProbe','ShareProbe','RecapShareProbe','DebugDisclosure'];
export const excludedStrings = ['--headless','--fixture','--fixtures-only','--menu-probe','--desktop-probe','--keyboard-probe','--share-probe','--benchmark','--bridge-config','--output','--root','SECRET_RECAP_ID','SECRET_PROVIDER_LABEL','PRIVATE_UNTRUSTED_OUTPUT','Preview & Diagnostics'];
