using UnrealBuildTool;

public class ForgeGameplay : ModuleRules
{
	public ForgeGameplay(ReadOnlyTargetRules Target) : base(Target)
	{
        // UE4.27's shared PCH embeds sandbox-specific debug records with newer MSVC.
        PCHUsage = PCHUsageMode.NoPCHs;
		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"Json"
		});
	}
}
