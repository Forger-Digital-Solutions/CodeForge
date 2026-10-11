using UnrealBuildTool;
using System.Collections.Generic;

public class DeadTrailsWestEditorTarget : TargetRules
{
	public DeadTrailsWestEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V2;
		ExtraModuleNames.Add("DeadTrailsWest");
	}
}
