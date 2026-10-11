using UnrealBuildTool;
using System.Collections.Generic;

public class DeadTrailsWestTarget : TargetRules
{
	public DeadTrailsWestTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V2;
		ExtraModuleNames.Add("DeadTrailsWest");
	}
}
