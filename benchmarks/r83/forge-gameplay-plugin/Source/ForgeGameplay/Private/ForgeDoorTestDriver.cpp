#include "ForgeDoorTestDriver.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "ForgeDoorSaveGame.h"
#include "ForgeInteractCharacter.h"
#include "ForgeInteractableDoor.h"
#include "ForgeInteractableWindow.h"
#include "Components/StaticMeshComponent.h"
#include "Camera/CameraActor.h"
#include "Engine/GameViewportClient.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Kismet/KismetRenderingLibrary.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/PlayerInput.h"
#include "HAL/FileManager.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	constexpr float MoveArriveCm = 12.f;
	constexpr float StallWindowS = 1.5f;
	constexpr float StallProgressCm = 1.f;

	FString JsonStr(const TSharedPtr<FJsonObject>& O, const TCHAR* Key, const FString& Fallback = TEXT(""))
	{
		FString V;
		return (O.IsValid() && O->TryGetStringField(Key, V)) ? V : Fallback;
	}

	double JsonNum(const TSharedPtr<FJsonObject>& O, const TCHAR* Key, double Fallback = 0.0)
	{
		double V = Fallback;
		O->TryGetNumberField(Key, V);
		return V;
	}

	FVector JsonVec(const TSharedPtr<FJsonObject>& O, const TCHAR* Key)
	{
		FVector V = FVector::ZeroVector;
		const TArray<TSharedPtr<FJsonValue>>* Arr;
		if (O->TryGetArrayField(Key, Arr) && Arr->Num() >= 3)
		{
			V.X = (*Arr)[0]->AsNumber();
			V.Y = (*Arr)[1]->AsNumber();
			V.Z = (*Arr)[2]->AsNumber();
		}
		return V;
	}

	TSharedPtr<FJsonValue> VecJson(const FVector& V)
	{
		TArray<TSharedPtr<FJsonValue>> A;
		A.Add(MakeShared<FJsonValueNumber>(V.X));
		A.Add(MakeShared<FJsonValueNumber>(V.Y));
		A.Add(MakeShared<FJsonValueNumber>(V.Z));
		return MakeShared<FJsonValueArray>(A);
	}

	TSharedPtr<FJsonObject> ParseJsonFile(const FString& Path)
	{
		FString Content;
		if (!FFileHelper::LoadFileToString(Content, *Path))
		{
			return nullptr;
		}
		TSharedPtr<FJsonObject> Obj;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Content);
		return FJsonSerializer::Deserialize(Reader, Obj) ? Obj : nullptr;
	}

	bool WriteJsonFile(const FString& Path, const TSharedPtr<FJsonObject>& Obj)
	{
		FString Out;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
		if (!FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer))
		{
			return false;
		}
		return FFileHelper::SaveStringToFile(Out, *Path);
	}
}

AForgeDoorTestDriver::AForgeDoorTestDriver()
{
	PrimaryActorTick.bCanEverTick = true;
}

void AForgeDoorTestDriver::BeginPlay()
{
	Super::BeginPlay();
	bStarted = LoadSpec();
}

bool AForgeDoorTestDriver::LoadSpec()
{
	FParse::Value(FCommandLine::Get(), TEXT("ForgeDriverSpec="), SpecPath);
	if (SpecPath.IsEmpty())
	{
		Errors.Add("no -ForgeDriverSpec argument");
		return false;
	}
	const TSharedPtr<FJsonObject> Spec = ParseJsonFile(SpecPath);
	if (!Spec.IsValid())
	{
		Errors.Add(FString::Printf(TEXT("spec unreadable: %s"), *SpecPath));
		return false;
	}
	RunId = JsonStr(Spec, TEXT("runId"));
	ReportPath = JsonStr(Spec, TEXT("reportPath"));
	CheckpointPath = JsonStr(Spec, TEXT("checkpointPath"));
	MapPackage = JsonStr(Spec, TEXT("mapPackage"));
	SaveSlot = JsonStr(Spec, TEXT("saveSlot"), AForgeInteractableDoor::GetSaveSlotName());
	const TArray<TSharedPtr<FJsonValue>>* Arr;
	if (!Spec->TryGetArrayField(TEXT("actions"), Arr))
	{
		Errors.Add("spec has no actions");
		return false;
	}
	for (const TSharedPtr<FJsonValue>& V : *Arr)
	{
		Actions.Add(V->AsObject());
	}
	ResumeFromCheckpoint();
	return true;
}

bool AForgeDoorTestDriver::ResumeFromCheckpoint()
{
	if (CheckpointPath.IsEmpty() || !IFileManager::Get().FileExists(*CheckpointPath))
	{
		return false;
	}
	const TSharedPtr<FJsonObject> Cp = ParseJsonFile(CheckpointPath);
	if (!Cp.IsValid() || JsonStr(Cp, TEXT("runId")) != RunId)
	{
		return false;
	}
	CurrentIndex = (int32)JsonNum(Cp, TEXT("resumeIndex"), 0);
	const TArray<TSharedPtr<FJsonValue>>* Prior;
	if (Cp->TryGetArrayField(TEXT("completed"), Prior))
	{
		Completed = *Prior;
	}
	const TArray<TSharedPtr<FJsonValue>>* PriorErrs;
	if (Cp->TryGetArrayField(TEXT("errors"), PriorErrs))
	{
		for (const TSharedPtr<FJsonValue>& E : *PriorErrs)
		{
			Errors.Add(E->AsString());
		}
	}
	return true;
}

void AForgeDoorTestDriver::WriteCheckpoint(int32 ResumeIndex)
{
	TSharedPtr<FJsonObject> Cp = MakeShared<FJsonObject>();
	Cp->SetStringField(TEXT("runId"), RunId);
	Cp->SetNumberField(TEXT("resumeIndex"), ResumeIndex);
	Cp->SetArrayField(TEXT("completed"), Completed);
	TArray<TSharedPtr<FJsonValue>> Errs;
	for (const FString& E : Errors)
	{
		Errs.Add(MakeShared<FJsonValueString>(E));
	}
	Cp->SetArrayField(TEXT("errors"), Errs);
	WriteJsonFile(CheckpointPath, Cp);
}

AForgeInteractCharacter* AForgeDoorTestDriver::ResolvePawn() const
{
	const APlayerController* PC = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr;
	return PC ? Cast<AForgeInteractCharacter>(PC->GetPawn()) : nullptr;
}

AForgeInteractableDoor* AForgeDoorTestDriver::FindDoor(const FString& IdOrName) const
{
	for (TActorIterator<AForgeInteractableDoor> It(GetWorld()); It; ++It)
	{
		if (It->DoorInstanceId.ToString() == IdOrName || It->GetName() == IdOrName
#if WITH_EDITOR
			|| It->GetActorLabel() == IdOrName
#endif
		)
		{
			return *It;
		}
	}
	return nullptr;
}

FVector AForgeDoorTestDriver::DoorWorldPos(const AForgeInteractableDoor* Door) const
{
	return Door ? Door->GetActorLocation() : FVector::ZeroVector;
}

double AForgeDoorTestDriver::ObservedDoorYaw(const AForgeInteractableDoor* Door) const
{
	// A placed door can face any world direction; the swing is measured in its frame.
	return (Door && Door->LeafMesh) ? (double)Door->LeafMesh->GetComponentTransform().GetRelativeTransform(Door->GetActorTransform()).Rotator().Yaw : 0.0;
}

void AForgeDoorTestDriver::Sample()
{
	const AForgeInteractCharacter* Pawn = ResolvePawn();
	if (Pawn == nullptr || !Cur.Record.IsValid())
	{
		return;
	}
	TSharedPtr<FJsonObject> S = MakeShared<FJsonObject>();
	S->SetNumberField(TEXT("t"), FMath::RoundToDouble(Clock * 100.0) / 100.0);
	const FVector L = Pawn->GetActorLocation();
	S->SetNumberField(TEXT("x"), L.X);
	S->SetNumberField(TEXT("y"), L.Y);
	S->SetNumberField(TEXT("z"), L.Z);
	Cur.Samples.Add(MakeShared<FJsonValueObject>(S));
}

void AForgeDoorTestDriver::StartAction(const TSharedPtr<FJsonObject>& Action)
{
	Cur = FActionState();
	Cur.Record = MakeShared<FJsonObject>();
	Cur.Record->SetNumberField(TEXT("index"), CurrentIndex);
	const FString Op = JsonStr(Action, TEXT("op"));
	Cur.Record->SetStringField(TEXT("op"), Op);
	const AForgeInteractCharacter* Pawn = ResolvePawn();
	if (Pawn != nullptr)
	{
		Cur.Start = Pawn->GetActorLocation();
		Cur.Record->SetField(TEXT("start"), VecJson(Cur.Start));
	}
	if (Op == TEXT("wait") || Op == TEXT("moveTo")) return;
    if (Op == TEXT("screenshot"))
    {
        ASceneCapture2D* Camera = GetWorld()->SpawnActor<ASceneCapture2D>();
        const FVector From = JsonVec(Action, TEXT("from"));
        Camera->SetActorLocation(From);
        Camera->SetActorRotation((JsonVec(Action, TEXT("target")) - From).Rotation());
        UTextureRenderTarget2D* Target = NewObject<UTextureRenderTarget2D>(Camera);
        Target->RenderTargetFormat = RTF_RGBA8;
        Target->InitAutoFormat(1280, 720);
        USceneCaptureComponent2D* Capture = Camera->GetCaptureComponent2D();
        Capture->TextureTarget = Target;
        Capture->CaptureSource = SCS_FinalColorLDR;
        Capture->bCaptureEveryFrame = false;
        Capture->CaptureScene();
        const FString OutputPath = JsonStr(Action, TEXT("screenshotPath"));
        IFileManager::Get().Delete(*OutputPath, false, true);
        UKismetRenderingLibrary::ExportRenderTarget(GetWorld(), Target, FPaths::GetPath(OutputPath), FPaths::GetCleanFilename(OutputPath));
        const bool bCaptured = IFileManager::Get().FileSize(*OutputPath) > 0;
        Cur.Record->SetBoolField(TEXT("pass"), bCaptured);
        if (!bCaptured) Errors.Add(TEXT("native render target capture missing: ") + OutputPath);
        Camera->Destroy();
        Cur.Record->SetStringField(TEXT("path"), JsonStr(Action, TEXT("screenshotPath")));
        Cur.Record->SetField(TEXT("cameraCm"), VecJson(From));
        return;
    }
	if (Op == TEXT("press"))
	{
		APlayerController* PC = GetWorld()->GetFirstPlayerController();
		const FString Key = JsonStr(Action, TEXT("key"), TEXT("E"));
		Cur.Record->SetStringField(TEXT("key"), Key);
		Cur.Record->SetStringField(TEXT("inputClass"), TEXT("SYNTHETIC_INPUT"));
		if (PC == nullptr || PC->PlayerInput == nullptr)
		{
			Cur.Record->SetBoolField(TEXT("dispatched"), false);
			Cur.Record->SetStringField(TEXT("error"), TEXT("no PlayerInput"));
			return;
		}
		AForgeInteractCharacter* P = ResolvePawn();
		if (P != nullptr)
		{
			P->bLastInteractDispatched = false;
			P->LastInteractTargetName = NAME_None;
			P->LastInteractDistanceCm = 0.f;
			P->LastInteractResultState = NAME_None;
			P->LastSweepHits.Reset();
		}
		PC->PlayerInput->InputKey(FKey(FName(*Key)), IE_Pressed, 1.f, false);
		PC->PlayerInput->InputKey(FKey(FName(*Key)), IE_Released, 0.f, false);
		// PlayerInput queues the event — the binding may not fire until the next
		// input pump. Results are read in TickAction once the dust settles.
		return;
	}
	if (Op == TEXT("face"))
	{
		// A real player turns to look at the door; the interaction sweep follows
		// the controller's aim. Set both so actor and view agree either way.
		const FVector Target = JsonVec(Action, TEXT("target"));
		AForgeInteractCharacter* P = ResolvePawn();
		if (P != nullptr)
		{
			const FRotator Aim = (Target - P->GetActorLocation()).GetSafeNormal().Rotation();
			P->SetActorRotation(Aim);
			if (AController* C = P->GetController())
			{
				C->SetControlRotation(Aim);
			}
			Cur.Record->SetNumberField(TEXT("yaw"), P->GetActorRotation().Yaw);
		}
		return;
	}
    if (Op == TEXT("expectWindow"))
    {
        const FString Id = JsonStr(Action, TEXT("window"));
        const FString Expected = JsonStr(Action, TEXT("state"));
        AForgeInteractableWindow* Window = nullptr;
        for (TActorIterator<AForgeInteractableWindow> It(GetWorld()); It; ++It)
            if (It->WindowInstanceId.ToString() == Id) Window = *It;
        bool bPass = false;
        if (Window) {
            const float Observed = Window->SlidePivot->GetRelativeLocation().Z;
            const float Target = Expected == TEXT("open") ? Window->OpenTravelCm : 0.f;
            bPass = Window->ForgeGetInteractState().ToString() == FString::Printf(TEXT("window.%s"), *Expected)
                && FMath::IsNearlyEqual(Observed, Target, 0.1f)
                && FMath::IsNearlyEqual(Window->SashMesh->GetComponentLocation().Z - Window->GetActorLocation().Z, Target, 0.1f);
            Cur.Record->SetStringField(TEXT("state"), Window->ForgeGetInteractState().ToString());
            Cur.Record->SetNumberField(TEXT("observedSlideCm"), Observed);
            Cur.Record->SetNumberField(TEXT("sashWorldZ"), Window->SashMesh->GetComponentLocation().Z);
            Cur.Record->SetNumberField(TEXT("commandedSlideCm"), Window->SlideCm);
            Cur.Record->SetBoolField(TEXT("restored"), Window->bRestored);
        }
        Cur.Record->SetBoolField(TEXT("pass"), bPass);
        if (!bPass) Errors.Add(TEXT("expectWindow failed: ") + Id);
        return;
    }
	if (Op == TEXT("expectDoor"))
	{
		const FString DoorId = JsonStr(Action, TEXT("door"));
		const FString Expected = JsonStr(Action, TEXT("state"));
		const double Tol = JsonNum(Action, TEXT("toleranceDeg"), 3.0);
		AForgeInteractableDoor* Door = FindDoor(DoorId);
		Cur.Record->SetStringField(TEXT("door"), DoorId);
		Cur.Record->SetStringField(TEXT("expectedState"), Expected);
		if (Door == nullptr)
		{
			Cur.Record->SetBoolField(TEXT("pass"), false);
			Cur.Record->SetStringField(TEXT("error"), TEXT("door not found"));
			return;
		}
		const double ObsYaw = ObservedDoorYaw(Door);
		const FName State = Door->ForgeGetInteractState();
		Cur.Record->SetNumberField(TEXT("obsYawDeg"), ObsYaw);
		Cur.Record->SetField(TEXT("actorPositionCm"), VecJson(Door->GetActorLocation()));
		Cur.Record->SetNumberField(TEXT("actorYawDeg"), Door->GetActorRotation().Yaw);
		Cur.Record->SetNumberField(TEXT("actorPitchDeg"), Door->GetActorRotation().Pitch);
		Cur.Record->SetNumberField(TEXT("actorRollDeg"), Door->GetActorRotation().Roll);
		Cur.Record->SetNumberField(TEXT("leafWorldYawDeg"), Door->LeafMesh->GetComponentRotation().Yaw);
		Cur.Record->SetNumberField(TEXT("hingeYawDeg"), Door->HingePivot ? (double)Door->HingePivot->GetRelativeRotation().Yaw : 0.0);
		Cur.Record->SetNumberField(TEXT("cmdYawDeg"), (double)Door->LeafYawDeg);
		Cur.Record->SetStringField(TEXT("state"), State.ToString());
		bool bPass = State.ToString() == FString::Printf(TEXT("door.%s"), *Expected);
		if (Expected == TEXT("open"))
		{
			bPass = bPass && FMath::Abs(ObsYaw - Door->OpenAngleDeg) <= Tol;
		}
		else if (Expected == TEXT("closed"))
		{
			bPass = bPass && FMath::Abs(ObsYaw) <= Tol;
		}
		Cur.Record->SetBoolField(TEXT("pass"), bPass);
		if (!bPass)
		{
			Errors.Add(FString::Printf(TEXT("expectDoor %s: state=%s obsYaw=%.2f"), *DoorId, *State.ToString(), ObsYaw));
		}
		return;
	}
	if (Op == TEXT("probe"))
	{
		const FVector From = JsonVec(Action, TEXT("from"));
		const FVector To = JsonVec(Action, TEXT("to"));
		FHitResult Hit;
		FCollisionQueryParams Params;
		Params.AddIgnoredActor(ResolvePawn());
		const bool bHit = GetWorld()->LineTraceSingleByChannel(Hit, From, To, ECC_Visibility, Params);
		Cur.Record->SetField(TEXT("from"), VecJson(From));
		Cur.Record->SetField(TEXT("to"), VecJson(To));
		Cur.Record->SetBoolField(TEXT("blockingHit"), bHit);
		if (bHit)
		{
			Cur.Record->SetStringField(TEXT("hitActor"), Hit.GetActor() ? Hit.GetActor()->GetName() : TEXT("?"));
			Cur.Record->SetStringField(TEXT("hitComponent"), Hit.GetComponent() ? Hit.GetComponent()->GetName() : TEXT("?"));
		}
		return;
	}
	if (Op == TEXT("save"))
	{
		int32 Count = 0;
		for (TActorIterator<AForgeInteractableDoor> It(GetWorld()); It; ++It)
		{
			if (It->PersistDoorState())
			{
				++Count;
			}
		}
		Cur.Record->SetStringField(TEXT("slot"), SaveSlot);
		Cur.Record->SetNumberField(TEXT("savedDoors"), Count);
        int32 Windows = 0;
        for (TActorIterator<AForgeInteractableWindow> It(GetWorld()); It; ++It)
            if (It->PersistWindowState()) ++Windows;
        Cur.Record->SetNumberField(TEXT("savedWindows"), Windows);
		return;
	}
	if (Op == TEXT("slotVerify"))
	{
		Cur.Record->SetStringField(TEXT("slot"), SaveSlot);
		const bool bExists = UGameplayStatics::DoesSaveGameExist(SaveSlot, 0);
		Cur.Record->SetBoolField(TEXT("slotExists"), bExists);
		if (!bExists)
		{
			return;
		}
		UForgeDoorSaveGame* Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::LoadGameFromSlot(SaveSlot, 0));
		Cur.Record->SetBoolField(TEXT("loaded"), Save != nullptr);
		if (Save == nullptr)
		{
			return;
		}
		Cur.Record->SetNumberField(TEXT("schemaVersion"), Save->SchemaVersion);
		TSharedPtr<FJsonObject> Doors = MakeShared<FJsonObject>();
		for (const auto& Pair : Save->Doors)
		{
			TSharedPtr<FJsonObject> Rec = MakeShared<FJsonObject>();
			Rec->SetNumberField(TEXT("state"), Pair.Value.State);
			Rec->SetNumberField(TEXT("leafYawDeg"), Pair.Value.LeafYawDeg);
			Doors->SetField(Pair.Key.ToString(), MakeShared<FJsonValueObject>(Rec));
		}
		Cur.Record->SetField(TEXT("doors"), MakeShared<FJsonValueObject>(Doors));
        TSharedPtr<FJsonObject> Windows = MakeShared<FJsonObject>();
        for (const auto& Pair : Save->Windows) {
            TSharedPtr<FJsonObject> Rec = MakeShared<FJsonObject>();
            Rec->SetNumberField(TEXT("state"), Pair.Value.State);
            Rec->SetNumberField(TEXT("slideCm"), Pair.Value.SlideCm);
            Rec->SetNumberField(TEXT("schemaVersion"), Pair.Value.SchemaVersion);
            Windows->SetObjectField(Pair.Key.ToString(), Rec);
        }
        Cur.Record->SetObjectField(TEXT("windows"), Windows);
		return;
	}
	if (Op == TEXT("writeCorruptSave"))
	{
		const FString Path = FPaths::ProjectSavedDir() / TEXT("SaveGames") / (SaveSlot + TEXT(".sav"));
		const bool bOk = FFileHelper::SaveStringToFile(TEXT("FORGE-CORRUPT-NOT-A-SAVEGAME"), *Path);
		Cur.Record->SetBoolField(TEXT("ok"), bOk);
		Cur.Record->SetStringField(TEXT("path"), Path);
		return;
	}
    if (Op == TEXT("writeInvalidWindowRecord"))
    {
        UForgeDoorSaveGame* Save = Cast<UForgeDoorSaveGame>(UGameplayStatics::LoadGameFromSlot(SaveSlot, 0));
        const FString Id = JsonStr(Action, TEXT("window"));
        bool bOk = Save != nullptr && !Id.IsEmpty();
        if (bOk) {
            FForgeWindowRecord& Record = Save->Windows.FindOrAdd(FName(*Id));
            Record.SchemaVersion = 99;
            Record.State = (uint8)EForgeWindowState::Open;
            Record.SlideCm = 999.f;
            bOk = UGameplayStatics::SaveGameToSlot(Save, SaveSlot, 0);
        }
        Cur.Record->SetBoolField(TEXT("ok"), bOk);
        if (!bOk) Errors.Add(TEXT("invalid-record fixture write failed"));
        return;
    }
	if (Op == TEXT("deleteSave"))
	{
		Cur.Record->SetBoolField(TEXT("ok"), UGameplayStatics::DeleteGameInSlot(SaveSlot, 0));
		return;
	}
	if (Op == TEXT("reloadMap"))
	{
		Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
		WriteCheckpoint(CurrentIndex + 1);
		Cur.Record.Reset();
		UGameplayStatics::OpenLevel(this, FName(*MapPackage));
		return;
	}
	if (Op == TEXT("exit"))
	{
		Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
		Cur.Record.Reset();
		FinishReport();
		ExitGame();
		return;
	}
	Errors.Add(FString::Printf(TEXT("unknown op: %s"), *Op));
}

void AForgeDoorTestDriver::TickAction(float DeltaSeconds)
{
	const TSharedPtr<FJsonObject>& Action = Actions[CurrentIndex];
	const FString Op = JsonStr(Action, TEXT("op"));
	Cur.Elapsed += DeltaSeconds;
    if (Op == TEXT("screenshot")) {
        if (Cur.Elapsed >= 1.f) {
            Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
            ++CurrentIndex;
            Cur.Record.Reset();
        }
        return;
    }

	if (Op == TEXT("wait"))
	{
		if (Cur.Elapsed >= JsonNum(Action, TEXT("durationS"), 1.0))
		{
			Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
			++CurrentIndex;
			Cur.Record.Reset();
		}
		return;
	}
	if (Op == TEXT("moveTo"))
	{
		const FVector Target = JsonVec(Action, TEXT("target"));
		const double TimeoutS = JsonNum(Action, TEXT("timeoutS"), 10.0);
		AForgeInteractCharacter* Pawn = ResolvePawn();
		if (Pawn == nullptr)
		{
			if (Cur.Elapsed > 5.f)
			{
				Cur.Record->SetStringField(TEXT("error"), TEXT("no pawn"));
				Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
				++CurrentIndex;
			}
			return;
		}
		const FVector Loc = Pawn->GetActorLocation();
		const FVector To2 = FVector(Target.X - Loc.X, Target.Y - Loc.Y, 0.f);
		const float Dist = To2.Size();
		if (Dist <= MoveArriveCm)
		{
			Cur.Record->SetBoolField(TEXT("arrived"), true);
			Cur.Record->SetField(TEXT("end"), VecJson(Loc));
			Cur.Record->SetNumberField(TEXT("displacementCm"), FVector::Dist2D(Loc, Cur.Start));
			Sample();
			Cur.Record->SetArrayField(TEXT("samples"), Cur.Samples);
			Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
			++CurrentIndex;
			Cur.Record.Reset();
			return;
		}
		Pawn->AddMovementInput(To2.GetSafeNormal(), 1.f);
		Sample();
		const float Remaining = Dist;
		if (FMath::Abs(Remaining - Cur.LastProgressSample) < StallProgressCm)
		{
			Cur.StallTime += DeltaSeconds;
		}
		else
		{
			Cur.StallTime = 0.f;
			Cur.LastProgressSample = Remaining;
		}
		const bool bStalled = Cur.StallTime >= StallWindowS;
		if (Cur.Elapsed >= TimeoutS || bStalled)
		{
			Cur.Record->SetBoolField(TEXT("arrived"), false);
			Cur.Record->SetBoolField(TEXT("stalled"), bStalled);
			Cur.Record->SetField(TEXT("end"), VecJson(Loc));
			Cur.Record->SetNumberField(TEXT("displacementCm"), FVector::Dist2D(Loc, Cur.Start));
			if (Cur.Samples.Num() > 0)
			{
				Cur.Record->SetArrayField(TEXT("samples"), Cur.Samples);
			}
			Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
			++CurrentIndex;
			Cur.Record.Reset();
		}
		return;
	}
	if (Op == TEXT("press"))
	{
		if (Cur.Elapsed >= 0.25f)
		{
			const AForgeInteractCharacter* P = ResolvePawn();
			if (P != nullptr)
			{
				Cur.Record->SetBoolField(TEXT("dispatched"), P->bLastInteractDispatched);
				Cur.Record->SetStringField(TEXT("targetName"), P->LastInteractTargetName.ToString());
				Cur.Record->SetNumberField(TEXT("distanceCm"), P->LastInteractDistanceCm);
				Cur.Record->SetStringField(TEXT("resultState"), P->LastInteractResultState.ToString());
				Cur.Record->SetNumberField(TEXT("sweepYawDeg"), P->LastSweepYawDeg);
				TArray<TSharedPtr<FJsonValue>> HitArr;
				for (const FString& H : P->LastSweepHits)
				{
					HitArr.Add(MakeShared<FJsonValueString>(H));
				}
				Cur.Record->SetArrayField(TEXT("sweepHits"), HitArr);
			}
			Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
			++CurrentIndex;
			Cur.Record.Reset();
		}
		return;
	}
	// Instant actions finished in StartAction.
	Completed.Add(MakeShared<FJsonValueObject>(Cur.Record));
	++CurrentIndex;
	Cur.Record.Reset();
}

void AForgeDoorTestDriver::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	Clock += DeltaSeconds;
	if (!bStarted || bFinished)
	{
		return;
	}
	if (CurrentIndex >= Actions.Num())
	{
		FinishReport();
		ExitGame();
		return;
	}
	if (Cur.Record == nullptr)
	{
		StartAction(Actions[CurrentIndex]);
		return;
	}
	TickAction(DeltaSeconds);
}

void AForgeDoorTestDriver::FinishReport()
{
	if (bFinished)
	{
		return;
	}
	bFinished = true;
	TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("runId"), RunId);
	Root->SetBoolField(TEXT("executed"), true);
	Root->SetStringField(TEXT("mapPackage"), MapPackage);
	Root->SetStringField(TEXT("saveSlot"), SaveSlot);
	Root->SetBoolField(TEXT("pythonModuleLoaded"), FModuleManager::Get().IsModuleLoaded(TEXT("PythonScriptPlugin")));
	Root->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Root->SetArrayField(TEXT("actions"), Completed);
	TArray<TSharedPtr<FJsonValue>> Errs;
	for (const FString& E : Errors)
	{
		Errs.Add(MakeShared<FJsonValueString>(E));
	}
	Root->SetArrayField(TEXT("errors"), Errs);
	TArray<TSharedPtr<FJsonValue>> Doors;
	for (TActorIterator<AForgeInteractableDoor> It(GetWorld()); It; ++It)
	{
		TSharedPtr<FJsonObject> D = MakeShared<FJsonObject>();
		D->SetStringField(TEXT("instanceId"), It->DoorInstanceId.ToString());
		D->SetStringField(TEXT("actor"), It->GetName());
		D->SetStringField(TEXT("state"), It->ForgeGetInteractState().ToString());
		D->SetNumberField(TEXT("obsYawDeg"), ObservedDoorYaw(*It));
		D->SetNumberField(TEXT("cmdYawDeg"), It->LeafYawDeg);
		Doors.Add(MakeShared<FJsonValueObject>(D));
	}
	Root->SetArrayField(TEXT("doors"), Doors);
	WriteJsonFile(ReportPath, Root);
	if (!CheckpointPath.IsEmpty())
	{
		IFileManager::Get().Delete(*CheckpointPath);
	}
}

void AForgeDoorTestDriver::ExitGame()
{
	FGenericPlatformMisc::RequestExit(false);
}
