const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const unit = [
  'src/renderer/src/components/appearanceSettingsTargets.test.ts',
  'src/shared/appAppearance.test.ts',
  'src/shared/appearanceLayers.test.ts',
  'src/shared/materials.test.ts',
  'src/shared/theme.test.ts',
  'src/renderer/src/app/appearanceNavigationGuard.test.ts',
  'src/renderer/src/app/pageDock.test.ts',
  'src/renderer/src/app/uiMotion.test.ts',
  'src/renderer/src/app/useAppNavigation.test.ts',
  'src/renderer/src/components/appearancePointerBoundaries.test.cjs',
  'src/renderer/src/components/SettingsPage.theme.test.ts',
  'src/renderer/src/components/settings-page/settingsNavigation.test.ts',
  'src/renderer/src/components/theme-studio/themeVisualControls.test.ts',
  'src/renderer/src/composables/appearanceLayersPersistence.test.ts',
  'src/renderer/src/composables/useAppearanceDraft.test.ts',
  'src/renderer/src/composables/useBackgroundAppearanceEditor.palette.test.ts',
  'src/renderer/src/editor/appearanceLayerView.test.ts',
  'src/renderer/src/editor/createEditorParallax.test.ts',
  'src/renderer/src/editor/createEditorTransition.test.ts',
  'src/renderer/src/editor/createEditorViewport.test.ts',
  'src/renderer/src/utils/backgroundImagePalette.test.ts'
]
const ui = [
  'src/renderer/src/components/AppearanceCapabilities.behavior.test.ts',
  'src/main/persistence/appearanceLayers.test.ts',
  'src/main/themes/themeArchive.icons.behavior.test.ts',
  'src/renderer/src/app/appearanceLayersRuntime.behavior.test.ts',
  'src/renderer/src/app/appearanceWorkspace.integration.test.ts',
  'src/renderer/src/app/backgroundImageFallback.behavior.test.ts',
  'src/renderer/src/app/settingsOverlay.behavior.test.ts',
  'src/renderer/src/components/AppearanceChromeSettings.behavior.test.ts',
  'src/renderer/src/components/AppearanceHomeMaterial.behavior.test.ts',
  'src/renderer/src/components/AppearancePage.behavior.test.ts',
  'src/renderer/src/components/AppearanceSurfaceInspector.behavior.test.ts',
  'src/renderer/src/components/AppearanceViewAngleControl.behavior.test.ts',
  'src/renderer/src/components/AppearanceWindowPreview.behavior.test.ts',
  'src/renderer/src/components/BackgroundAppearanceCustomizer.behavior.test.ts',
  'src/renderer/src/components/MaterialContract.behavior.test.ts',
  'src/renderer/src/components/SettingsPage.organization.behavior.test.ts',
  'src/renderer/src/components/ThemeIcon.behavior.test.ts',
  'src/renderer/src/components/settings-page/SettingsColorMode.behavior.test.ts',
  'src/renderer/src/components/theme-studio/ThemeStudioApply.behavior.test.ts',
  'src/renderer/src/components/theme-studio/ThemeStudioPage.contextual.behavior.test.ts',
  'src/renderer/src/components/theme-studio/ThemeStudioRecovery.behavior.test.ts',
  'src/renderer/src/components/theme-workshop/ThemeWorkshopPage.behavior.test.ts',
  'src/renderer/src/editor/appearanceSurfaceDepth.behavior.test.ts',
  'src/renderer/src/utils/backgroundImagePalette.behavior.test.ts'
]

function runAppearanceTests(args = process.argv.slice(2), run = spawnSync) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--unit')) {
    throw new Error('Usage: node scripts/run-appearance-tests.cjs [--unit]')
  }
  const unitOnly = args[0] === '--unit'
  const result = run(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=1',
      ...(unitOnly ? ['--test-skip-pattern', '^Chromium projects'] : []),
      '--import',
      './scripts/register-renderer-aliases.mjs',
      ...unit,
      ...(unitOnly ? [] : ui)
    ],
    { cwd: resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true }
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

module.exports = { unit, ui, runAppearanceTests }
if (require.main === module) process.exitCode = runAppearanceTests()
