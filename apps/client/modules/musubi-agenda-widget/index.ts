import { NativeModule, requireOptionalNativeModule } from "expo";

declare class MusubiAgendaWidgetModule extends NativeModule {
  updateSnapshot(snapshot: string): Promise<void>;
  clearSnapshot(): Promise<void>;
  getCalendarWidgetSelection(widgetId: number): Promise<string[] | null>;
  setCalendarWidgetSelection(widgetId: number, calendarIds: string[]): Promise<void>;
}

export default requireOptionalNativeModule<MusubiAgendaWidgetModule>("MusubiAgendaWidget");
