package expo.modules.rovenativecontrols

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class RoveKeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RoveKeyboardCommands")

    View(RoveKeyboardCommandsView::class) {
      Prop("enabledCommands") { view: RoveKeyboardCommandsView, commands: List<String> ->
        view.enabledCommands = commands.toSet()
      }
      Events("onCommand")
    }
  }
}

class RoveKeyboardCommandsView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  var enabledCommands = emptySet<String>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val copiesThreadReference =
      event.action == KeyEvent.ACTION_DOWN &&
        event.repeatCount == 0 &&
        event.keyCode == KeyEvent.KEYCODE_C &&
        event.isCtrlPressed &&
        event.isShiftPressed &&
        !event.isAltPressed &&
        enabledCommands.contains("copyThreadReference")
    if (copiesThreadReference) {
      onCommand(mapOf("command" to "copyThreadReference"))
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}
